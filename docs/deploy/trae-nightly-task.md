# Trae 自动化任务 — MivoSentry 夜巡（03:30）

> 部署方式：在 Trae 自动化面板创建一个定时任务，触发时刻设为每日 **03:30**（macmini 本地时间）。选择该时刻是为了避开 08:00 的 GitHub Actions 每日更新日志任务、09:00 的自动部署，以及 mivo loop 两班车的运行窗口。任务提示词见下方"任务提示词"代码块——具体粘贴到面板哪个配置项，以 macmini 上 Trae 实际界面为准（本文档未实测该界面，字段名称待首次部署后据实补充，不在此假设固定名称）。

## 路径与环境（2026-08-01 已在 macmini 实测确认）

- **MivoSentry 仓在 macmini 上的绝对路径**：`/Users/praise/AI-Agent/Claude/projects/Project MivoSentry`（**经 Syncthing 从本机双向同步而来，不是独立 clone**；已实测存在。Syncthing 同步范围为 `~/About Praise`、`~/AI-Agent`、`/Volumes/AKB2/Obsidian` 三个目录）。
- **目标审计仓（MivoCanvas）绝对路径**：`/Users/praise/mivo-ops/mivo-canvas`（bug-doctor loop 的 checkout，**不在 Syncthing 范围内**；已实测存在，`history/loops/` 已被 `.gitignore` 排除故 loop 日志不污染 porcelain）。该 checkout 以 ff-only 跟随 `origin/main`，空闲时干净，代表**已发布的 main**——这正是审计该看的东西。
- **⚠ 不要审计 `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`**：Syncthing 把本机的 MivoCanvas 开发工作区也同步到了 mini，它就位于 MivoSentry 旁边、路径形态相似，极易误取。但那是 owner 的在途开发工作区（随时处于任意特性分支与脏状态），审计它只会得到"owner 此刻正在改的半成品"这类噪声，且其状态每几秒就被 Syncthing 改动一次，必然触发 G1 的只读自检失败。审计目标只有上面那一个。

### 硬纪律：本管道只在 macmini 上运行

MivoSentry 仓经 Syncthing **双向**同步，`reports/` 与 `state/` 的产物会同步回本机。因此：

- 晨报会自动出现在本机同路径下（便利）；
- **但绝不允许在本机也跑一次 `nightly-audit.mjs` 或 `issue-gate.mjs`**。两端都写 `state/fingerprints.json` 会触发 Syncthing 冲突，生成 `.sync-conflict-*` 副本并使指纹 store 分叉——指纹去重失效，重复 issue 风暴。单写者原则：**写者只有 macmini**。

### 环境实测差异（影响维度判定，非缺陷）

macmini 的 `/Users/praise/mivo-ops/mivo-canvas/node_modules/.bin` 下：`madge`/`ts-prune`/`knip` **均不存在**，`vitest` 存在。故该机上 `circular-dep` 判 `n_a`（契约禁止 npx 联网拉取未锁定版本）、`dead-code` 走 tsc+grep 降级路径并在报告注明。这是契约预期行为，不是运行失败。

## 任务提示词

（原样复制以下代码块，粘贴进 Trae 自动化任务承载提示词的配置项——具体字段名称以 macmini 实际界面为准；本提示词自包含，不依赖任何此前的对话上下文或长期记忆）

```
你现在执行 MivoSentry 夜巡自动化任务。不需要任何额外上下文，按顺序执行以下步骤，每步都要显式核对成功判据后才进入下一步。全程对 MivoCanvas 仓只读，不做任何写入尝试。

步骤 0 — 计算今日日期：
  执行：date +%F
  成功判据（两项全部满足才算成功）：
    a) 命令退出码为 0
    b) 输出匹配 YYYY-MM-DD 格式（四位年-两位月-两位日，如 2026-08-02）
  记录输出为 <TODAY>（用于后续文件名）。
  失败处理：退出码 ≠ 0，或输出格式不匹配 → 立即停止，跳到"失败报告"，写明"步骤 0 日期计算失败"及实际输出内容，不得继续后续步骤（后续步骤全部依赖 <TODAY> 拼文件名，日期算错会导致查错文件却误判为"晨报没出现"）。

步骤 1 — 进入哨兵仓：
  执行：cd "/Users/praise/AI-Agent/Claude/projects/Project MivoSentry"
  成功判据：命令返回码为 0；执行 pwd，输出应为 /Users/praise/AI-Agent/Claude/projects/Project MivoSentry。
  失败处理：路径不存在则立即停止，跳到"失败报告"，写明"哨兵仓路径不存在，需人工确认实际部署路径"，不得继续后续步骤。
  注意：该路径含空格，凡引用它的命令一律加双引号。

步骤 1.5 — 目标仓占用检查（防与 bug-doctor loop 争用，这一步不是可选的）：
  背景：审计目标 /Users/praise/mivo-ops/mivo-canvas 同时是 com.mivo.bug-doctor.patrol 这个 launchd 任务的工作目录，该任务每小时整点（:00）唤醒。它平时空转不碰工作区，但有真实 bug 记录进来时会建分支、commit、推 PR。若审计与它同时进行，G1 的只读自检（跑前后 git status --porcelain 必须一致）会把 loop 的改动误判成"审计违反了只读"并以 exit 4 退出——这是误报，不是真的只读违规，必须在开跑前避开而不是事后解释。
  依次执行三条只读命令并记录输出：
    a) launchctl list | awk '$3=="com.mivo.bug-doctor.patrol"{print $1}'
    b) git -C /Users/praise/mivo-ops/mivo-canvas branch --show-current
    c) git -C /Users/praise/mivo-ops/mivo-canvas status --porcelain | wc -l
  放行判据（三项全部满足才继续）：
    a) 输出为单个字符 - （表示 patrol 当前未在运行；若是数字则它正在跑）
    b) 输出为 main
    c) 输出为 0
  不满足时的处理：不算失败，跳到"跳过报告"（见下），不得强行继续、不得为了跑通而 checkout/stash/reset 目标仓的任何状态（那会破坏 loop 的在途工作，且违反对 MivoCanvas 只读的红线）。

步骤 2 — 跑 G1 夜间机械审计（对 MivoCanvas 仓只读）：
  执行：node scripts/audit/nightly-audit.mjs --repo /Users/praise/mivo-ops/mivo-canvas
  成功判据（四项全部满足才算成功）：
    a) 命令退出码为 0（该脚本约定：0=跑完，1=用法错，2=环境错——含跑前只读快照不可得，3=指纹碰撞（有诊断报告、无 findings），4=只读自检失败（产物可能已写出但不可信）。失败报告里须写明具体退出码：3 属身份冲突类、4 属只读违规类，两者处置不同不可混报）
    b) 文件 reports/nightly-<TODAY>.md 存在
    c) 该文件首行匹配"派 N 维度 / 成 M / 败 K / n_a J"对账格式（N/M/K/J 为具体数字）
    d) 文件 state/findings-<TODAY>.json 存在，且内容可被 JSON.parse 成功、顶层为数组（G1 契约规定的两份产物之一，只验报告不验 findings 会漏掉"报告写出来了但 G2 消费不到数据"的情况）
  失败处理：
    - 退出码 ≠ 0 → 原样重跑同一条命令一次（仅重试 1 次）
    - 重试后仍 ≠ 0，或 (b)(c)(d) 任一不满足 → 停止本步之后的所有步骤，跳到"失败报告"，如实记录两次尝试的退出码、stderr 原文，以及 (b)(c)(d) 各项的具体观测结果（如 findings 文件是否存在、JSON.parse 是否成功、顶层实际类型）；不得声称成功、不得再重试第二次

步骤 3 — 跑 G2 issue 闸门（dry-run，不带 --send，零网络写）：
  执行：node scripts/issues/issue-gate.mjs --findings state/findings-<TODAY>.json --report reports/nightly-<TODAY>.md --repo xindong/mivo-canvas
  （--report 必须显式给出：G2 不显式指定时按 findings 目录反推报告路径，一旦两类产物不在同一父目录下就会静默退化成"回退占位对账行"——e2e 演练已实测到该退化。钉死路径不靠推断。）
  成功判据（两项全部满足才算成功）：
    a) 命令退出码为 0（该脚本约定：0=完成，1=用法/findings 格式错，2=store 损坏或 token 文件缺失——本步不带 --send，正常情况不应出现退出码 2）
    b) 标准输出中包含"将单发 N 条 / 汇总 1 条"形态的预览文本（N 为具体数字）
  失败处理：同步骤 2（原样重跑一次；重试后仍失败或 (b) 不满足 → 停止，跳到"失败报告"，不重试第二次）
  硬约束：本步骤命令不得添加 --send 参数。任何情况下都不得自行决定加 --send。本任务提示词的 dry-run 性质是**永久性的**，不因后续获得放开授权而改变；真发流程是一条独立的人工手动命令（见 runbook.md「真发（--send）流程」），绝不通过编辑本文件或本任务的面板配置来实现。

步骤 4 — 汇总回报（仅当步骤 1-3 全部成功时执行）：
  在本次自动化任务的最终输出中给出以下内容，缺一不可：
    - 步骤 1-3 每步的实际退出码
    - 晨报绝对路径：/Users/praise/AI-Agent/Claude/projects/Project MivoSentry/reports/nightly-<TODAY>.md
    - 该文件首行对账行原文（"派 N 维度 / 成 M / 败 K / n_a J"）
    - 步骤 3 打印的"将单发 N 条 / 汇总 1 条"预览原文
    - 明确声明本次运行状态为"成功"

跳过报告（仅当步骤 1.5 的放行判据未满足时执行，替代步骤 2 及之后的全部步骤）：
  在本次自动化任务的最终输出中给出以下内容：
    - 明确声明"本次夜巡跳过（目标仓被 bug-doctor loop 占用），非失败"
    - 步骤 1.5 三条命令 a)b)c) 各自的实际输出值
    - 指出是哪一项或哪几项不满足放行判据
    - 不做任何补救动作、不改目标仓状态、不改用其他 checkout 顶替审计目标
  说明：跳过是设计内的正常分支。连续多晚跳过才值得人工介入（说明 loop 长期占用或状态卡死），单晚跳过无需处理。

失败报告（仅当步骤 0、1、2 或 3 未通过成功判据时执行，替代步骤 4）：
  在本次自动化任务的最终输出中给出以下内容：
    - 明确声明"本次夜巡失败于步骤 X"（X = 0、1、2 或 3；步骤 1.5 不满足走"跳过报告"而非本报告，两者不可混用）
    - 该步骤逐项列出未通过的具体判据编号（如步骤 2 的 (c)(d)）及每项判据的实际观测值（如"reports/nightly-2026-08-02.md 首行实际内容为 ...，不匹配对账格式"、"state/findings-2026-08-02.json 不存在"、"JSON.parse 抛出 SyntaxError: ..."）——不得只写"判据不满足"这类不含观测值的空泛结论
    - 该步骤两次尝试（若已重试）的退出码
    - 最后一次尝试的 stderr 原文（如有输出）
    - 明确声明本次运行状态为"失败"，不得输出任何暗示成功的措辞
  失败后不得自行修复脚本、不得跳过失败步骤继续往后跑、不得对 MivoCanvas 仓做任何写入尝试、不得自行加 --send 尝试"补救"。
```

## 部署后自检（人工，一次性）

首次把上面的提示词粘贴进 Trae 自动化任务后，若面板提供手动触发/立即运行功能，建议用它触发一次（不等到 03:30）；若面板不提供该功能，可改为直接在终端里按提示词描述的步骤 0-3 手动执行一遍等效命令来验证，效果相同。确认：
1. 步骤 1、1.5、2、3 均能跑通并输出预期格式；
2. 若 MivoSentry 仓实际路径与本文档记录不同，任务已失败在步骤 1 并给出"路径不存在"的报告（而非静默假装成功）；
3. 若恰好撞上 patrol 运行窗口，任务给出的是"跳过报告"（附三条命令的实际输出值），而不是 exit 4 的"只读自检失败"——这是步骤 1.5 存在的唯一目的，验收时值得刻意确认一次。

**为什么触发时刻仍选 03:30**：patrol 在每小时整点唤醒，03:30 落在两次唤醒之间的最大间隙里，同时避开 08:00 的 GitHub Actions 每日更新日志任务与 09:00 的自动部署。实测截至 2026-08-01，patrol 最近 350 次唤醒全部是 `s0-only` / `newRecords: 0` 的空转（约 14 天未改动过工作区），故撞车概率低；步骤 1.5 是给"真有 bug 记录进来那一晚"准备的保险，不是日常路径。
