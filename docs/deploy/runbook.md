# MivoSentry Runbook

## 链路图

自动化链路（03:30，永久 dry-run，见 `trae-nightly-task.md`；**下面这条链路永远不带 `--send`，任何情况下都不改**）：

```
03:30 Trae 自动化任务触发（见 trae-nightly-task.md）
     │
     ▼
G1  node scripts/audit/nightly-audit.mjs --repo /Users/praise/mivo-ops/mivo-canvas-plugin
     │  9 个机械维度各自独立子进程 + 120s 超时；单维度失败/超时不中断整轮，如实计入报告
     │  对 --repo 目标仓只读（跑前后对比 `git -C /Users/praise/mivo-ops/mivo-canvas-plugin status --porcelain` 一致）
     ▼
产物：reports/nightly-<date>.md（首行对账行）  +  state/findings-<date>.json（finding 数组，含指纹）
     │
     ▼
G2  node scripts/issues/issue-gate.mjs --findings state/findings-<date>.json --repo xindong/mivo-canvas-plugin
     │  指纹查重（state/fingerprints.json）→ 已知指纹跳过
     │  P0/P1 且五字段齐 → 单发队列；其余 → 并入当日汇总 issue
     ▼
终端打印"将单发 N 条 / 汇总 1 条" + 正文预览，零网络写 —— 自动化任务到此结束
```

真发链路（**独立的人工手动命令，不属于上面的自动化任务、不进 Trae 面板**；放开条件与失败处理见下方「真发（`--send`）流程」）：

```
owner 手动在终端执行（见下方独立命令与前置检查）
     ▼
node scripts/issues/issue-gate.mjs --findings state/findings-<date>.json \
  --repo xindong/mivo-canvas-plugin --send --token-file ~/.config/trae-secrets/mivo-issues-token
     │  GH_TOKEN 环境变量前缀注入 token，逐条调用 gh issue create（label=trae-audit + severity label）
     ▼
issue 落地到 xindong/mivo-canvas-plugin
```

G3（锚点盘点，`scripts/anchor/anchor-map.mjs`）不在 03:30 夜巡链路里，是独立按需触发的盘点工具，产物 `docs/anchor-map.md`；出问题时的排查不进本 runbook 的夜巡故障表，故障表只覆盖 G1→G2 这条自动化链路。

## 故障排查表

| 故障 | 检查命令 | 排查思路 |
|---|---|---|
| **晨报没出现**（`reports/nightly-<date>.md` 不存在） | ①（若 Trae 面板提供任务执行历史/日志功能）查该任务的执行记录，确认 03:30 是否真的触发过——面板具体入口以 macmini 实际界面为准，本文档未实测该界面、不假设固定字段名；面板不提供该功能时改看 `ls -la /Users/praise/mivo-ops/mivo-sentry/reports/` 的文件 mtime 辅助判断；② 手动重跑并显式核对退出码（先 `export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`——非交互 shell 下 `node` 会 command not found；全绝对路径，不依赖之前命令残留的 `cd`）：`node /Users/praise/mivo-ops/mivo-sentry/scripts/audit/nightly-audit.mjs --repo /Users/praise/mivo-ops/mivo-canvas-plugin --out-dir /Users/praise/mivo-ops/mivo-sentry/reports --state-dir /Users/praise/mivo-ops/mivo-sentry/state; echo "exit=$?"`；③ 确认目录存在且**实际可写**（不只看权限位）：`test -d /Users/praise/mivo-ops/mivo-sentry/reports && echo dir-ok; test -w /Users/praise/mivo-ops/mivo-sentry/reports && echo writable-ok`；④ `df -h /Users/praise/mivo-ops/mivo-sentry` 确认磁盘未满；⑤ **确认脚本是不是旧版**：本仓不走 Syncthing，`git pull --ff-only` 是更新到达 mini 的唯一通道，夜巡步骤 1 会做这件事——若那步被跳过或失败，mini 会长期跑旧版脚本而毫无征兆。查 `git -C /Users/praise/mivo-ops/mivo-sentry log --oneline -1` 与 GitHub 上 main 的 HEAD 是否一致 | 先确认"任务没跑"还是"任务跑了但脚本失败"还是"脚本成功但写不出文件"，三种原因排查命令不同，别一上来就重跑脚本 |
| **某维度连续 n_a**（如 `circular-dep` 连续多晚都是 n_a） | ① 打开当晚 `reports/nightly-<date>.md`，看该维度行给出的 n_a 具体原因文案（note 字段）；② 按维度手动验证根因——两个维度的实现方式不同，验证命令不能混用：`circular-dep` **只用目标仓本地 `node_modules/.bin/madge`**（v2 起禁止夜巡 npx 联网拉取；一次性迁移说明：此前 npx 时代扫出的 25 条 P2 循环依赖 finding 因目标仓无本地 madge 而从产物中消失，跨轮不可直接对比——要恢复该维度覆盖，需在目标仓正式声明锁定版本的 madge 依赖），检查命令：`ls -la /Users/praise/mivo-ops/mivo-canvas-plugin/node_modules/.bin/madge`；`dead-code` 维度检查的是**目标仓自身** `node_modules/.bin/` 下是否已装 ts-prune/knip（不经 npx 临时下载），`npx ts-prune --version` 测的是 npm registry 可达性，跟该维度实际逻辑无关、验不出真实原因——应改为只读检查目标仓：`ls -la /Users/praise/mivo-ops/mivo-canvas-plugin/node_modules/.bin/ts-prune /Users/praise/mivo-ops/mivo-canvas-plugin/node_modules/.bin/knip` 确认二进制是否存在，`grep -e '"ts-prune"' -e '"knip"' /Users/praise/mivo-ops/mivo-canvas-plugin/package.json` 确认是否声明该依赖；二者皆无 → 报告给出的降级原因属实；已声明/已存在但报告仍 n_a → 按该行 note 文案给出的具体降级路径复现（如 note 提到 tsc 降级不可用，则检查 `node_modules/.bin/tsc` 是否存在）；`log-violation` 用 `cd /Users/praise/mivo-ops/mivo-canvas-plugin && npm run verify:logging` 看该 scripts 是否真的不存在 | 若报告注明是"目标仓本身没有对应能力"（如 mivo-canvas-plugin 没有 `verify:logging` 脚本，或未装 ts-prune/knip），这是**目标仓现状，不是哨兵故障**，不需要修哨兵；只有当底层工具本该能拉到/用到却拉不到用不到（网络/npx 缓存/依赖缺失之外的问题）才算真故障 |
| **指纹库损坏**（`state/fingerprints.json` 读不出/解析失败） | 用真实的 `loadStore()` 实现验证，不要自己重写 JSON.parse 判断逻辑（否则会和脚本行为不一致——文件不存在或内容为空，脚本视为合法空 store，不是损坏）：`node -e "import('/Users/praise/mivo-ops/mivo-sentry/scripts/issues/fingerprint.mjs').then(({loadStore})=>{try{const s=loadStore('/Users/praise/mivo-ops/mivo-sentry/state/fingerprints.json');console.log('OK, fingerprints 数：',Object.keys(s.fingerprints).length)}catch(e){console.error('CORRUPT:',e.message);process.exit(1)}})"` —— 只有打印 `CORRUPT:` 才证实损坏（对应 JSON 语法错或 `fingerprints` 结构不合法两种情形）；文件不存在/为空会打印 `OK, fingerprints 数：0`，不是故障 | ① 先用绝对路径、且不覆盖已有备份的方式备份现场：`cp -n /Users/praise/mivo-ops/mivo-sentry/state/fingerprints.json "/Users/praise/mivo-ops/mivo-sentry/state/fingerprints.json.corrupt-$(date +%F_%H%M%S).bak"`；② 检查是否有并发写入：本仓在 Syncthing 同步树之外，跨机同步不会造成写争用，故只需排查**同一台机器上是否有两个审计/闸门进程同时在跑**（如手动重跑与 03:30 自动任务撞上）：`pgrep -fl 'nightly-audit|issue-gate'`；③ 清空重建会导致所有历史 finding 被当作"新"重新走一轮分流判断（可能触发大量重复单发），**清空前必须 owner 确认可接受** |
| **exit 2 或 401/403**（`issue-gate.mjs` 退出码 2，或 `--send` 时报权限错误 / API 401/403） | 退出码 2 有三种不同原因，先看 stderr 前缀区分，不要混为一谈：① stderr 以 `[store 损坏]` 开头 → 与 `--send` 无关（这项检查每次运行都会做，dry-run 也会触发），按上面"指纹库损坏"行排查；② stderr 以 `[token 缺失]` 开头 → 仅带 `--send` 时才会检查，说明 `--token-file` 未给或指向的文件不存在，先 `ls -la ~/.config/trae-secrets/mivo-issues-token` 确认文件路径与内容；③ stderr 以 `[issue-gate] 未捕获异常` 开头，且异常信息里出现 401/403/Bad credentials 等 gh CLI 报错 → 是真实的 GitHub 侧权限/过期问题，跑 `trae-verify-token.md` 的只读三查定位是 scope 不足还是 token 已过期/被 revoke；若三查此前通过过现在突然失败，需 owner 重新生成 token 放到同路径（文件名不变） | dry-run（不带 `--send`）阶段只可能触发①，不会触发②③——②③ 都要求真正带 `--send` 才会跑到对应代码路径；所以"token 权限/过期"这类问题必须放开 `--send` 后才会暴露，放开前先跑一遍三查能降低风险，但三查通过不代表放开后 100% 不会遇到① |

## 真发（`--send`）流程

**`--send` 从来不是编辑 03:30 自动化任务、不是给 `trae-nightly-task.md` 加参数或改面板字段——那份提示词永久 dry-run，任何情况下都不改。** 真发是一条完全独立的、由 owner 在需要时手动敲一次的一次性命令，不进 Trae 自动化面板、不写入任何长期运行的任务配置。

### 放开条件（缺一不可）

1. owner 已实际看过**至少 1 个完整夜晚**的 dry-run 输出（当晚的晨报 `reports/nightly-<date>.md` + `issue-gate.mjs` 打印的"将单发 N 条 / 汇总 1 条"预览正文），确认分流结果（哪些该单发、哪些该进汇总）符合预期；
2. `trae-verify-token.md` 的只读三查全部通过（fine-grained PAT 场景下含 owner 在 GitHub 后台的人工核对），确认 `~/.config/trae-secrets/mivo-issues-token` 是降权后的受限 token；
3. owner 显式授权放开（口头/文字确认即可，不需要额外审批流程）。

### 独立命令（人工手动执行；不写入任何自动化面板/任务提示词）

三个条件都满足后，owner 在终端里对**当天**的 findings 手动跑一次。

**必须在 macmini 上执行（不是 owner 本机）**：`--send` 成功后会把指纹写入 `state/fingerprints.json`，而两台机器各有一份**独立的**指纹库（本仓不走 Syncthing，故两份互不知情）。本机那份不知道 mini 已经发过哪些 issue，在本机带 `--send` 跑会把已发过的 finding 当作全新的再发一遍。若人在本机，用 `ssh Praise-Mini` 登进去再跑，或用等效的远程执行通道；不要图省事在本机跑。

```
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin   # 非交互 shell 下 node 不在默认 PATH
cd /Users/praise/mivo-ops/mivo-sentry
node scripts/issues/issue-gate.mjs \
  --findings state/findings-<TODAY>.json \
  --repo xindong/mivo-canvas-plugin \
  --commit "$(git -C /Users/praise/mivo-ops/mivo-canvas-plugin rev-parse HEAD)" \
  --send --token-file ~/.config/trae-secrets/mivo-issues-token
```

**`--commit` 不能省**：契约规定 `--send` 时存在待单发 issue 但无 `--commit` → exit 2 拒发（防止 issue 环境节写成 `commit: unknown`，让接手的同事不知道审的是哪个版本）。上面用 `rev-parse HEAD` 取的是**发送时刻**目标仓的 sha——该仓 ff-only 跟随 origin/main，通常与 03:30 审计时一致；但若 03:30 之后仓被 pull 过（如早上 9:00 部署窗口前后），HEAD 已前进，此时应放弃当天真发（findings 是对旧 sha 的观测，配新 sha 会误导），等下一晚的产物再发。

前置检查（跑之前）：
- 确认 `state/findings-<TODAY>.json` 是当晚 03:30 自动任务真实产出的文件（对应当晚已经看过的 dry-run 预览），不是手动重跑生成的另一份；
- 确认目标仓 HEAD 自 03:30 后没有前进（对比产物 mtime 与 `git -C /Users/praise/mivo-ops/mivo-canvas-plugin log -1 --format=%cI` 的提交时间可粗判；拿不准就当晚不发）；
- 确认此刻没有另一个审计/闸门进程在跑（避免与 03:30 自动任务或其他手动操作撞上，触发指纹库并发写入）。

### 失败处理（真发模式专属，禁止套用 dry-run 的"重跑一次"规则）

`gh issue create` **不是幂等操作**——同一条 finding 重复调用会创建两条重复 issue，不是"和上次一样所以没事"。真发模式的失败处理因此与 `trae-nightly-task.md` 里"退出码非 0 就整轮重跑一次"的规则完全不同，**禁止套用那条规则**：

- 命令执行中途任何一步失败（单个 `gh issue create` 报错、进程被中断等）→ **立即停手，不得整轮重试**。`issue-gate.mjs` 是逐条顺序调用 `gh issue create`，失败点之前的条目大概率已经真实创建到 GitHub 上；盲目重跑整条命令会把这些已创建的条目再发一遍。
- 停手后，owner 先核对**实际已发出的清单**——以 GitHub 端为准、按正文里的指纹码逐条匹配（标题不保证唯一；预览是发送前一次性打印的，"打印过"不等于"已创建"）：
  ```
  GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh issue list -R xindong/mivo-canvas-plugin --label trae-audit --state all --limit 200 --json number,title,body \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const i of JSON.parse(d)){const m=(i.body||'').match(/[0-9a-f]{16}/);console.log(i.number, m?m[0]:'无指纹', i.title)}})"
  ```
  拿输出的指纹集合与本轮 findings 对照，确认哪些已真实创建。
- **落盘语义（契约行为，v2）**：每条 issue 创建成功后其指纹**即刻**写回 `state/fingerprints.json`；部分失败时进程以 **exit 3** 结束（成功项已落盘、失败项未标记）。对账时仍以上一步 GitHub 端指纹匹配为最终依据，本地 store 作交叉核对。
- 核对清单后，owner 决定下一步：**直接重跑同一条 `--send` 命令即可**——已成功项会被指纹去重跳过，只补发失败项（这是 exit 3 语义的设计目的）。若个别条目需手工补发，命令必须钉死受限 token 前缀，禁止裸调 gh 回退到全局身份：
  ```
  GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh issue create -R xindong/mivo-canvas-plugin --title "..." --body "..." --label trae-audit
  ```

**放开前，Trae 不得自主决定加 `--send`**——这不是脚本层面的技术限制，是纪律要求（见 `trae-memory-append.md` 第 6 条），必须由 owner 主动执行上面的独立命令。
