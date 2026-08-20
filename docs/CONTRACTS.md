# MivoSentry 接口契约（v2，经四域三轮审查修订收口）

> 所有脚本按此契约实现与消费。改契约 = 全体重审，不许单方漂移。
> 运行环境：macmini，Node ≥ 18，零外部依赖优先（只用 node 内置 + 仓内已有工具）。
> 全局纪律：审计/盘点对目标仓**只读**；一切 gh 写操作默认 dry-run，真发需显式 `--send`。
> v1→v2 变更（2026-08-01 收口）：G1 退出码增 3/4、line 语义判别式、指纹公式四段化、
> circular-dep 本地化、--sample 子命令、G2 退出码 2 括注修正 + 新增 3、verify 措辞降级、
> 汇总体量 fail-safe。指纹换代：v1 时期任何 store 记录全部作废（从未真发过，无存量需清）。

## 通用 location 语义（G1 产出、G2 消费、一切渲染遵守）

- `line` 为**正整数** = 行级 finding；`line` 为 **0** = 文件级/图级 finding 的 sentinel。
- 一切人读展示（晨报/样例/issue title/表格行）遇 `line=0` **只显示文件名，禁止拼 `:0`**。

## 目录

```
scripts/audit/    G1 夜间机械审计引擎
scripts/issues/   G2 指纹去重 + issue 闸门
scripts/anchor/   G3 锚点盘点
prompts/          给 Trae 的提示词
docs/deploy/      G4 部署包（Trae 记忆/自动化提示词/runbook）
state/            运行状态（fingerprints.json 等；.gitignore 排除运行产物，保留 .gitkeep）
reports/          晨报输出（运行产物，不入库；样例入 docs/examples/）
```

## G1 `scripts/audit/nightly-audit.mjs`

```
node scripts/audit/nightly-audit.mjs --repo <目标仓绝对路径> \
  [--dims csv] [--out-dir reports] [--state-dir state]
```

- 9 个机械维度（全部确定性命令，**零模型调用**）：
  `deps-vuln`(npm audit --json) / `dead-code`(优先目标仓 node_modules/.bin 下 ts-prune/knip，均无则用 tsc+grep 降级并在报告注明) /
  `todo-stale`(git blame TODO/FIXME 超 90 天) / `log-violation`(目标仓 `npm run verify:logging`，无此脚本则 n_a) /
  `type-escape`(grep -c `\bany\b`/`as any`/`@ts-ignore`/`@ts-expect-error`，按文件聚合) /
  `secret-pattern`(grep 正则: key/token/password 赋值、dangerouslySetInnerHTML、eval；**测试路径上的凭据命中 skip+计数，不写入 findings**，危险 API 仍写) /
  `circular-dep`(**仅用目标仓本地 `node_modules/.bin/madge`**；本地二进制不存在才 n_a 并注明；**禁止 npx 联网拉取未锁定版本**) /
  `test-health`(grep `.skip(`/`.only(` + 新增 src 文件无同名/同目录 test 的清单) /
  `debt-metric`(超 300 行文件、超 80 行函数清单——只报指标不做价值判断；跨日呈现为 delta/首日基线)
- **n_a 与败的边界**：n_a 仅限"工具/脚本在目标仓不存在"；工具存在但执行非零、启动失败、超时 → 一律计**败**。
  子命令非零时**不因"碰巧解析出部分结果"而报成功**（防组合假绿）。
- **扫描范围**：文件枚举 = `git ls-files --cached --others --exclude-standard` 叠加 denylist
  （`.claude/**`、`_tmp/**`、`history/**`、`docs/design-previews/**`、`**/*.bundle.js`）；报告展示 scanned/excluded 计数。
- 每维度独立子进程 + 超时 120s；维度**运行时**失败/超时不中断整轮、如实计败入报。
- 输出两份：
  - `reports/nightly-<YYYY-MM-DD>.md` — **首行必须是对账行**：`派 N 维度 / 成 M / 败 K / n_a J`；
    正文结构：Severity×维度矩阵 + P0/P1 全列 + P2/P3 每维 top5（指向 JSON）+ debt delta；行数预算 ≤200
  - `state/findings-<YYYY-MM-DD>.json` — 数组，每条 schema：
    ```json
    {"dim":"type-escape","file":"src/x.ts","line":12,"category":"类型逃逸",
     "evidence":"as any ×3","severity":"P2","verify":"grep -n 'as any' src/x.ts",
     "fingerprint":"<sha256(file|dim|category|anchor)前16位>"}
    ```
- **指纹身份规则**（稳定身份 vs 可变观测，v2 核心变更）：
  种子 = `file|dim|category|anchor` 四段。`anchor` 为规范化内容锚点（文本命中=规范化行内容 hash+同内容序号；
  函数=函数名或规范化函数头 hash；文件级=固定字面量；图级=环成员排序后的成员串——最终 sha256 由 fingerprint() 对四段整体施加，anchor 本身不预先 hash）。
  **line/span/count/evidence 一律不进种子**（防"顶部加一行→指纹雪崩→重复 issue 风暴"）。
  rename/移动不追踪（rename 即新指纹，接受重报一次）。产物写出前强制唯一性断言，碰撞即 exit 3 不写 findings。
- **verify 字段**：动态参数一律 POSIX shellQuote 转义。定位为**不可信复现提示，执行前须人工确认**——
  不承诺 shell 安全，只承诺 Markdown 结构安全（G2 渲染层另有中和）。
- 退出码：0=跑完（有无 finding 都算）；1=用法错（含未知/重复 --dims，起 worker 前拒绝）；
  2=环境错（repo 不存在/非 git 仓/**pre 只读快照不可得**）；3=指纹碰撞（写诊断 report、不写 findings）；
  4=只读自检失败（含 post 快照不可得；**产物可能已写出但不可信**——自动化不得只用"文件存在"判成功）。
- **只读保证**：对 --repo 目标零写入。自检 = 跑前后 `git -C <repo> status --porcelain` 一致；
  pre 快照在任何 mkdir/写盘之前，post 快照在全部产物写完之后；
  **快照命令自身失败（非零/超时/启动失败）= 自检失败，绝不 fail-open 当 PASS**。
- **输出路径语义**：`--out-dir`/`--state-dir` 未显式传入时绑定 MivoSentry 脚本仓根（非调用 cwd）；
  显式相对路径按调用 cwd 解析；解析后（含 symlink 穿透）落入 --repo 内 → exit 1 拒绝执行。
- **`--sample` 子命令**：`--sample --findings <json> --report <md> --out <md>` 从真实产物分层抽样自动生成样例，
  声明条数必须等于实际条数，禁止手改样例数据（一次性迁移披露句除外，须注明）。

## G2 `scripts/issues/`

- `fingerprint.mjs`（库）：`loadStore(path)` / `isKnown(fp)` / `markSeen(fp, meta)` / `save()`；store = `state/fingerprints.json`。
- `issue-gate.mjs`（CLI）：
  ```
  node scripts/issues/issue-gate.mjs --findings state/findings-<date>.json \
    --repo xindong/mivo-canvas [--send] [--token-file ~/.config/trae-secrets/mivo-issues-token]
  ```
- 分流规则：
  1. 指纹已 known → 跳过（计数）
  2. severity=P0/P1 **且** 五字段齐（文件:行/类别/证据/验证方式/指纹）→ 单发队列
  3. 其余 → 并入当日汇总 issue（表格 + 低置信区）
- **issue 格式对齐 cindy 仓规范**（`Project CINDY/.github/ISSUE_TEMPLATE/bug_report.yml` 的字段结构）：
  - 单发 title：`audit: <类别> — <file>:<line>`；label：`trae-audit` + severity label
  - 正文四节（对应 cindy 模板）：`## 问题描述`（实际 vs 期望）/ `## 环境`（commit sha + 扫描日期 + 维度）/ `## 复现步骤`（= verify 命令；**不可信复现提示，执行前人工确认**，不承诺 shell 安全）/ `## 日志与证据`（evidence + 指纹码；**粘贴前脱敏**）
  - 汇总 title：`audit: 夜巡汇总 <YYYY-MM-DD>`；正文首行 = G1 对账行；随后按**严重度分节**（P0→P1→P2，各节六列表：位置/维度/问题/证据/验证/指纹，"问题"列为固定人话文案）；**P3 不逐条进表**，只按维度报聚合计数 + 一句"明细在夜巡机器晨报，不随 issue 附带"（2026-08-02 owner 决策 1a：实测 886 条 P3 逐条进表必触发体量截断且无人阅读）。低置信区一节不变
  - **人话解释层**：`render.mjs` 内置 category→人话 / dim→人话 静态文案映射（`explainFinding`），单发 issue 问题描述节首段与汇总"问题"列均使用；纯静态文案无插值，注入面为零；未命中映射回退 category 原文（照常转义）
  - **体量截断指针只写文件名**（如 `findings-<date>.json`），不写夜巡机器绝对路径——issue 在公司仓，绝对路径对读者是死链且泄露目录结构
- gh 调用**固定形态**：`GH_TOKEN=$(cat <token-file>) gh issue create -R <repo> ...`（实现为 execFile + 隔离 env 注入 GH_TOKEN，语义等价且防注入；清除继承的 GH_*/GITHUB_* 变量、独立空 GH_CONFIG_DIR）——绝不落全局 gh 身份。
- 默认 dry-run：打印"将单发 N 条 / 汇总 1 条"+ 完整正文预览（预览头显式区分 DRY-RUN/SEND），零网络写、**对 store 零写**。`--send` 才真发。
- **known 语义**：指纹仅在对应 issue **确认创建成功后**逐条标记落盘（成功即刻持久化）；dry-run/预览不消费指纹。
- **汇总体量 fail-safe**：汇总正文按 60000 字符预算截断表格行 + 尾部"省略 N 行，完整清单见当日 findings JSON"；
  --send 时正文仍超 65000 字符 → exit 2 拒发（防御性）。完整分片方案挂起，待真实夜巡体量数据后另立契约。
- **--send 前置 fail-closed**：存在待单发却无 --commit、或存在待汇总却只有回退占位对账行 → exit 2 拒发（dry-run 不受限）。
- `--store` 为测试/隔离用途覆盖参数；生产一律默认 `state/fingerprints.json`。
- 退出码：0=完成；1=用法/findings 格式错；2=store 损坏（**所有模式都检查**，含零字节/空白文件）
  或 token 文件缺失/空白（仅 --send 时检查）——其他未捕获运行异常也以 2 退出；
  **3=部分发送失败**（仅 --send：任一条未成功即 3；成功项已落盘，重跑只补失败项）。
- **fingerprint.mjs 附注**：`__testing__` 导出仅供白盒测试访问锁内部实现，不属于四函数操作契约。

## G3 `scripts/anchor/anchor-map.mjs` + `prompts/anchor-scan.md`

```
node scripts/anchor/anchor-map.mjs --repo <路径> --out docs/anchor-map.md
```

- 探测优先级：仓内有 vitest/jest coverage 脚本 → 用之；没有（MivoCanvas 现状：Playwright e2e smoke，unit 框架未知，**须实测探测不许假设**）→ 降级为存在性判据：
  模块（src 一级目录）× {有无对应 test 文件, test 内 `expect(` 断言计数, `.skip/.only` 残留}
- 判定（机械，禁形容词）：无测试 → `danger`；有测试但断言数 < 文件数×3 → `weak`；否则 → `safe-candidate`（终审权在 owner，表格注明"待终审"）。
- 输出表：`模块 | 测试文件数 | 断言数 | coverage%(有则填) | 判定`，末行汇总三区占比。
- `prompts/anchor-scan.md`：给 Trae 的半交互盘点提示词（GLM-5.2 用），引用本脚本 + 要求逐模块给证据行。

## G4 `docs/deploy/`（四个文件）

1. `trae-memory-append.md` — 追加进 Trae 长期记忆的文本：发 issue 纪律（指纹去重/汇总式/五字段/默认 dry-run）+ 模型分工（GLM-5.2=判断与写码；DeepSeek Flash=摘要/文案/分类/提取）+ token 用法（GH_TOKEN 前缀形态，token 文件路径，禁入同步目录）
2. `trae-nightly-task.md` — Trae 自动化任务提示词：03:30 触发，跑 G1→G2(dry-run)→把晨报路径回报；含失败处理（脚本 exit≠0 时如实报，不重试超 1 次）
3. `trae-verify-token.md` — 降权验证提示词（只读三查：api user / permissions / issue list）
4. `runbook.md` — 链路图 + 每环节故障排查表（"晨报没出现查什么"三步）+ `--send` 放开条件（owner 看过 ≥1 晚 dry-run 后显式授权）

## 通用红线（所有 worker）

- 只写 `Project MivoSentry/` 自己的文件域；**对 MivoCanvas 仓只读**（G3 探测允许读 package.json/src/tests）
- 不 commit（lead 统一收口）；不 push；不发任何 issue/对外消息；不装 npm 依赖
  （v2 更正：夜巡**禁止** npx 联网拉取未锁定依赖——madge 等只认目标仓 `node_modules/.bin` 下已有的本地二进制，不存在则该维度 n_a）
- 脚本内不出现任何真实 token 值；token 只以"读文件路径"形态引用
