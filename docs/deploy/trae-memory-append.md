# Trae 长期记忆追加 — MivoSentry 哨兵纪律

> 用途：把以下内容追加进 Trae（macmini）的长期记忆。首次部署时手动追加一次；`trae-nightly-task.md` 的自动化任务本身**不依赖**这份记忆（任务提示词自包含），但 Trae 在人工交互场景下处理本管道相关请求时，应遵循这里的纪律。

## 发 issue 纪律

1. **指纹去重优先**：每条 finding 先查 `state/fingerprints.json`（经 `scripts/issues/fingerprint.mjs` 的 `isKnown(fp)`）。已知指纹 → 跳过并计数，不重复开 issue。
2. **单发 vs 汇总式**：只有 `severity=P0/P1` **且** 五字段齐全（文件:行 / 类别 / 证据 / 验证方式 / 指纹）才单发 issue（title：`audit: <类别> — <file>:<line>`；`line=0` 为文件/图级 sentinel，title 与一切展示省略 `:0` 只写文件名）；其余全部并入当日汇总 issue（title：`audit: 夜巡汇总 <YYYY-MM-DD>`，正文首行 = G1 对账行，然后按维度分节表格）。不得为图省事把低置信发现单发，也**不得通过篡改 severity 字段本身**（把实际是 P0/P1 的发现记为更低级别）来规避单发义务——这与第 3 条"P0/P1 五字段不全时降级进汇总"（severity 字段保持不变、只是路由不同）是两件不同的事，不要混淆。
3. **五字段是硬门槛**：五字段（文件:行 / 类别 / 证据 / 验证方式 / 指纹）缺任一项 → 该条不得单发，一律降级进汇总的低置信区（severity 字段本身不改，只是路由改为汇总；这是契约允许的正常路径，不算第 2 条禁止的"把 P0/P1 塞进汇总"）。
4. **label 固定**：单发与汇总 issue 都打 `trae-audit` 标签；单发额外加 severity label。
5. **正文四节固定顺序**（对齐 `Project CINDY/.github/ISSUE_TEMPLATE/bug_report.yml` 的字段结构）：`## 问题描述`（实际 vs 期望）/ `## 环境`（commit sha + 扫描日期 + 维度）/ `## 复现步骤`（= verify 命令；**不可信复现提示，执行前人工确认**，不承诺 shell 安全）/ `## 日志与证据`（evidence + 指纹码）。**证据粘贴前脱敏**：去除任何看起来像密钥/token/密码的字符串再写入正文。
6. **默认 dry-run，`--send` 才真发**：任何一次 `issue-gate.mjs` 调用，缺省即打印"将单发 N 条 / 汇总 1 条" + 完整正文预览，零网络写。只有显式带 `--send` 才产生真实 gh 网络调用。**未经 owner 授权（放开条件见 `runbook.md`）不得自行加 `--send`。**

## 模型分工

| 模型 | 负责 |
|---|---|
| **GLM-5.2** | 判断类工作（severity 复核、五字段是否齐全的裁决、是否满足 `--send` 放开条件的确认）+ 写码类工作（脚本修复、契约对齐改动） |
| **DeepSeek Flash** | 摘要/文案/分类/提取（汇总 issue 正文文案整理、findings 分类归纳、晨报要点摘要） |

分工原则：涉及"这条要不要发 issue"、"这条算不算 P0/P1"的最终判断，一律走 GLM-5.2；纯文本整理/归纳/摘要走 DeepSeek Flash 省成本。**不得用 DeepSeek Flash 做发 issue 与否的最终判断。**

## Token 用法

- token 文件固定路径：`~/.config/trae-secrets/mivo-issues-token`（明文文件，权限应为 600；不放入任何同步目录/云盘目录，不入任何 git 仓）。
- 调用 `gh issue create` **必须**用固定前缀形态注入，绝不落全局 gh 身份：
  ```
  GH_TOKEN=$(cat ~/.config/trae-secrets/mivo-issues-token) gh issue create -R <repo> ...
  ```
- 当前 macmini 上 `gh auth status` 显示的全局登录身份（PraiseZhu，权限含 `admin:org`/`admin:enterprise`/`delete_repo` 等管理类 scope，待降权）**不得**用于本管道的任何 issue 创建调用——那是给人用的交互身份，不是本管道的服务身份。本管道所有 gh 写操作只走上面的 `GH_TOKEN=` 前缀形态，绝不裸调 `gh issue create` 依赖当前登录态。
- 降权是否到位的验证流程见 `trae-verify-token.md`（只读三查，不涉及任何写操作）。
- token 文件内容绝不打印全文、绝不写入 findings/reports/issue 正文/日志；如需在日志中引用，只写"已从 token 文件读取"，不回显任何字符。
