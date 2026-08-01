# 降权验证提示词 — 只读三查

> 用途：确认 `~/.config/trae-secrets/mivo-issues-token` 里放的是**降权后**的受限 token，而不是当前 macmini 上 gh CLI 已登录的 PraiseZhu 个人身份（该身份权限含 `admin:org`/`admin:enterprise`/`delete_repo` 等管理类 scope，尚未降权，不得被本管道使用）。三查全部只读，零写操作，可交给 Trae 执行也可人工执行。

## 查 1 — 身份（token 对应哪个账号；仅留痕，不作为放行判据）

```
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh api user --jq '.login'
```

记录返回的 `login`。**注意**：无论是 classic PAT 还是 fine-grained PAT，只要 token 是由 PraiseZhu 本人账号生成的（即使权限已被严格降权到仅 Issues 读写），`/user` 接口返回的 `login` 都会是 `PraiseZhu`——账号身份与凭据权限范围是两件独立的事，`login` 字段验证不了"降权是否生效"。本查只用于留痕"这是谁生成的 token"，**不能**据此判断是否放行 `--send`；实际放行标准见查 2（权限范围）与本文末尾"三查通过标准"。

## 查 2 — 权限范围（scopes；classic 与 fine-grained PAT 分开验证）

```
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh api -i user 2>&1 | grep -i x-oauth-scopes
```

用 `GH_TOKEN=` 环境变量前缀 + `gh api -i`（`-i` 附带响应头）取代 `curl -H "Authorization: token $(...)"`——后者会把 token 明文展开进命令行参数，同机其他用户用 `ps aux` 就能看到；`gh api -i` 走环境变量注入子进程，不落 argv。

**分两种情况判读，两者验证方式不同**：

- **命令输出了非空的 `x-oauth-scopes` 行**（说明是 classic PAT）：scopes 列表里**只应含** issue 读写所需的最小权限（一般是 `repo`）。**不应出现** `admin:org`、`admin:enterprise`、`delete_repo`、`admin:public_key` 等管理类 scope——对照命令 `gh auth status`（查看当前 macmini 全局登录身份 PraiseZhu 的 scopes 清单）确认两者在管理类权限上**不重叠**。
- **命令没有输出 `x-oauth-scopes` 行，或该行为空**（fine-grained PAT 不走旧版 OAuth scope 模型，这个响应头本身验证不了 fine-grained token 的权限范围，不是命令用错）：**本查无法自动验证**，必须由 owner 登录 GitHub → Settings → Developer settings → Fine-grained personal access tokens，手动核对该 token 的 Repository access 仅限 `xindong/mivo-canvas`、Permissions 仅勾选 Issues: Read and write，且没有多余的仓库或权限。下面查 3 的只读 list 成功只能证明"有基本读权限"，不能替代这一步的人工核对。

## 查 3 — 目标仓可读性（issue list）

```
GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh issue list -R xindong/mivo-canvas --limit 5
```

预期：命令成功返回 issue 列表（或空列表），退出码 0。**本查只读**：不创建、不修改、不关闭任何 issue，只验证该 token 对目标仓 `xindong/mivo-canvas` 有基本读权限，为后续 `issue-gate.mjs --send` 铺路。

## 三查通过标准

放行标准以查 2（权限范围）与查 3（可读性）为准，**查 1 只留痕身份、不参与判定**：

- 查 2：classic PAT 下 `x-oauth-scopes` 只含最小必要 scope 且不含管理类 scope；fine-grained PAT 下由 owner 在 GitHub 后台完成人工核对；
- 查 3：命令成功返回列表（或空列表），退出码 0；
- 另需确认（非一次性检查，是持续纪律，见 `trae-memory-append.md` Token 用法一节）：本管道所有 gh 写操作都走 `GH_TOKEN=$(cat <token-file>)` 前缀注入，没有裸调 `gh issue create` 依赖当前登录态——即没有回退到查 1 记录到的全局身份。

任一项不符合预期 → 停止推进 `--send` 放开流程，回去检查 `~/.config/trae-secrets/mivo-issues-token` 的内容是否确实是降权后重新生成的 token（排除误放个人 token、误放空文件、token 已过期/被 revoke 三种常见情况）。
