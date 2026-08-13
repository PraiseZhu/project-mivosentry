# 降权验证提示词 — 只读三查

> 用途：确认 `~/.config/trae-secrets/mivo-issues-token` 里放的是**降权后**的受限 token，而不是当前 macmini 上 gh CLI 已登录的 PraiseZhu 个人身份（该身份权限含 `admin:org`/`admin:enterprise`/`delete_repo` 等管理类 scope，尚未降权，不得被本管道使用）。全部只读，零写操作，可交给 Trae 执行也可人工执行。

## 查 0 — 对照测试：证明 gh 真的在用 GH_TOKEN（必须先跑，否则后面全是假的）

```
GH_TOKEN=ghp_invalidinvalidinvalid gh api user --jq .login
```

**预期：报错 `Bad credentials`。**

为什么这条不能省：`gh` 在 `GH_TOKEN` 缺失或被忽略时会回退到 keyring / `hosts.yml` 里的已登录身份。若发生回退，查 1 到查 3 全都在测那个全局 PraiseZhu 身份（它对 `xindong/mivo-canvas-plugin` 是 ADMIN），三查会全绿——而你以为验的是那个受限 token。这是一条典型的假边：链路看着通，其实两端没连上。

若这条**返回了 `PraiseZhu` 而不是报错** → `gh` 忽略了 `GH_TOKEN`，立即停止，后面三查的结果一律不可采信，先查清 gh 版本与认证配置。

## 查 1 — 身份（token 对应哪个账号；仅留痕，不作为放行判据）

```
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh api user --jq '.login'
```

记录返回的 `login`。**注意**：无论是 classic PAT 还是 fine-grained PAT，只要 token 是由 PraiseZhu 本人账号生成的（即使权限已被严格降权到仅 Issues 读写），`/user` 接口返回的 `login` 都会是 `PraiseZhu`——账号身份与凭据权限范围是两件独立的事，`login` 字段验证不了"降权是否生效"。本查只用于留痕"这是谁生成的 token"，**不能**据此判断是否放行 `--send`；实际放行标准见查 2（权限范围）与本文末尾"三查通过标准"。

## 查 2 — 权限范围（scopes；classic 与 fine-grained PAT 分开验证）

```
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh api -i user 2>&1 | grep -iE '^x-oauth-scopes'
```

**`^` 行首锚定是必须的，不能写成 `grep -i x-oauth-scopes`。** 响应里有一行

```
Access-Control-Expose-Headers: ETag, Link, ..., X-OAuth-Scopes, X-Accepted-OAuth-Scopes, ...
```

它只是在**列举**该 API 可能暴露哪些头，不是真的 scopes 头。不锚行首会命中它，于是 fine-grained token（本就没有 scopes 头）看起来像 classic token，下面的分支判读直接走错。2026-08-02 首次实跑就撞上了这个误匹配。

用 `GH_TOKEN=` 环境变量前缀 + `gh api -i`（`-i` 附带响应头）取代 `curl -H "Authorization: token $(...)"`——后者会把 token 明文展开进命令行参数，同机其他用户用 `ps aux` 就能看到；`gh api -i` 走环境变量注入子进程，不落 argv。

**分两种情况判读，两者验证方式不同**：

- **命令输出了非空的 `x-oauth-scopes` 行**（说明是 classic PAT）：scopes 列表里**只应含** issue 读写所需的最小权限（一般是 `repo`）。**不应出现** `admin:org`、`admin:enterprise`、`delete_repo`、`admin:public_key` 等管理类 scope——对照命令 `gh auth status`（查看当前 macmini 全局登录身份 PraiseZhu 的 scopes 清单）确认两者在管理类权限上**不重叠**。
- **命令没有输出 `x-oauth-scopes` 行，或该行为空**（fine-grained PAT 不走旧版 OAuth scope 模型，这个响应头本身验证不了 fine-grained token 的权限范围，不是命令用错）：**本查无法自动验证**，必须由 owner 登录 GitHub → Settings → Developer settings → Fine-grained personal access tokens，手动核对该 token 的 Repository access 仅限 `xindong/mivo-canvas-plugin`、Permissions 仅勾选 Issues: Read and write，且没有多余的仓库或权限。下面查 3 的只读 list 成功只能证明"有基本读权限"，不能替代这一步的人工核对。

## 查 3 — 目标仓可读性（issue list）

```
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh issue list -R xindong/mivo-canvas-plugin --limit 5
```

预期：命令成功返回 issue 列表（或空列表），退出码 0。**本查只读**：不创建、不修改、不关闭任何 issue，只验证该 token 对目标仓 `xindong/mivo-canvas-plugin` 有基本读权限，为后续 `issue-gate.mjs --send` 铺路。

### 查 3 失败时的三路判别（别只说"停下来回查 token"）

失败最常见的形态是：

```
GraphQL: Could not resolve to a Repository with the name 'xindong/mivo-canvas-plugin'. (repository)
```

这条报错**不代表仓库不存在**——GitHub 对无权访问的私有仓一律回"解析不到"，不泄露存在性。所以它同时对应三种完全不同的原因，必须用下面两条只读命令分开：

```
# 判别 A：token 本身是否存活（fine-grained token 对公共仓永远可读）
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh api repos/cli/cli --jq .full_name

# 判别 B：仓库是否真的存在、名字有没有写错（故意用全局登录身份读，不带 GH_TOKEN）
gh api repos/xindong/mivo-canvas-plugin --jq '.full_name + "  private=" + (.private|tostring)'
```

| A（公共仓） | B（全局身份读私有仓） | 结论 | 该做什么 |
|---|---|---|---|
| 成功 | 成功 | **token 有效，只是对该仓无权** —— 组织 PAT 审批未通过或仍在排队（按钮曾显示 `Generate token and request access` 即属此类） | 联系 `xindong` 组织 owner 批准该 token 申请。**不要**重新生成 token（会作废现有申请、重新排队） |
| 失败 | 成功 | token 已过期 / 被 revoke / 文件内容不是有效 token | 重新生成并重新写入文件 |
| 任意 | 失败 | 仓库名写错，或连全局身份也没权限 | 先核对仓库全名，再谈 token |

判别 B 刻意**不带** `GH_TOKEN`，用的就是那个不该被管道使用的全局身份——这里只把它当"仓库是否存在"的探针，属于诊断用途，不构成管道对它的依赖。

## 三查通过标准

放行标准以查 0（对照）、查 2（权限范围）、查 3（可读性）为准，**查 1 只留痕身份、不参与判定**：

- 查 0：无效 token 必须报 `Bad credentials`。这条不通过则其余各查一律作废，不得当作已验证；
- 查 2：classic PAT 下 `^x-oauth-scopes` 只含最小必要 scope 且不含管理类 scope；fine-grained PAT 下由 owner 在 GitHub 后台完成人工核对；
- 查 3：命令成功返回列表（或空列表），退出码 0；
- 另需确认（非一次性检查，是持续纪律，见 `trae-memory-append.md` Token 用法一节）：本管道所有 gh 写操作都走 `GH_TOKEN=$(cat <token-file>)` 前缀注入，没有裸调 `gh issue create` 依赖当前登录态——即没有回退到查 1 记录到的全局身份。

任一项不符合预期 → 停止推进 `--send` 放开流程，回去检查 `~/.config/trae-secrets/mivo-issues-token` 的内容是否确实是降权后重新生成的 token（排除误放个人 token、误放空文件、token 已过期/被 revoke 三种常见情况）。
