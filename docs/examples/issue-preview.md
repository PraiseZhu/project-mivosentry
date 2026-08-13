# G2 issue-gate dry-run 预览样例

> 本文件由真实运行生成，不是手写样例。复现命令：
>
> ```bash
> cp tests/issues/fixtures/seed-fingerprints.json /tmp/preview-store.json
> node scripts/issues/issue-gate.mjs \
>   --findings tests/issues/fixtures/findings-2026-08-01.json \
>   --repo xindong/mivo-canvas-plugin \
>   --store /tmp/preview-store.json \
>   --report tests/issues/fixtures/reports/nightly-2026-08-01.md \
>   --commit deadbeef
> ```
>
> 夹具 `findings-2026-08-01.json` 含 8 条记录；`seed-fingerprints.json` 预置了其中 2 条的指纹（模拟"前一晚已上报过"），
> 用于演示指纹去重跳过。分流结果：跳过已知 2 条 / 单发 1 条（P0 且五字段齐）/ 汇总 5 条（其中 1 条 P1 因缺 `line` 字段落入低置信区）。
> dry-run 模式下不会有任何网络写入、也不会改动 `--store` 指向的文件一个字节（2026-08-01 修复 P0#1：
> 曾经 dry-run 也会 markSeen+save，导致真正 `--send` 时这些指纹已被当"见过"而永远发不出去）。

```
[issue-gate] dry-run 预览（仅预览，不会发送，store 零写）
将单发 1 条 / 汇总 1 条 / 跳过已知 2 条

--- 单发 #1 ---
title: audit: 疑似密钥硬编码 — server/lib/config.ts:18
labels: trae-audit, P0
body:
## 问题描述
实际: 疑似密钥硬编码 — const apiKey = 'sk-xxxx'
期望: 按下方复现步骤验证问题不再出现，再关闭本 issue。

## 环境
- 仓库: xindong/mivo-canvas-plugin
- commit: deadbeef
- 扫描日期: 2026-08-01
- 维度: secret-pattern

## 复现步骤
```
grep -n "apiKey = '" server/lib/config.ts
```

_以上命令来自审计脚本对仓库内容的自动提取，粘贴执行前请自行确认内容——不可信输入未做 shell 转义保证。_

## 日志与证据
- 证据: const apiKey = 'sk-xxxx'
- 指纹: 4af81119d7a72749


--- 汇总 ---
title: audit: 夜巡汇总 2026-08-01
labels: trae-audit
body:
派 9 维度 / 成 7 / 败 1 / n_a 1

> ⚠️ **注意**：本次汇总中有 1 条 P0/P1 因字段不全被降级到低置信区（未走单发通道），请人工核实——指纹: f3a5289629d79238

## 汇总

### todo-stale
| 文件:行 | 类别 | 严重度 | 证据 | 验证 | 指纹 |
|---|---|---|---|---|---|
| src/canvas/hooks/useSelection.ts:201 | 过期TODO | P2 | TODO(2026-02-01): 处理多选边界 | `git blame -L 201,201 src/canvas/hooks/useSelection.ts` | b52d6d19082787fe |

### debt-metric
| 文件:行 | 类别 | 严重度 | 证据 | 验证 | 指纹 |
|---|---|---|---|---|---|
| src/app/panels/InspectorPanel.tsx:1 | 超长文件 | P2 | 612 行 | `wc -l src/app/panels/InspectorPanel.tsx` | 84752e1bbf146697 |

### test-health
| 文件:行 | 类别 | 严重度 | 证据 | 验证 | 指纹 |
|---|---|---|---|---|---|
| src/lib/assets/eagleClient.ts:1 | 缺失测试 | P3 | 无同名 test 文件 | `ls src/lib/assets/eagleClient.test.ts` | 4dcace3b31a3a4c1 |

### log-violation
| 文件:行 | 类别 | 严重度 | 证据 | 验证 | 指纹 |
|---|---|---|---|---|---|
| src/canvas/actions/exportAsset.ts:77 | 日志缺口 | P2 | 失败路径未写 debugLogger | `grep -n debugLogger src/canvas/actions/exportAsset.ts` | 65ff48688c056d7b |

## 低置信区（字段不全，需人工补全后再判断是否升级为单发 issue）
| 文件:行 | 类别 | 严重度 | 缺失字段 | 证据 | 指纹 |
|---|---|---|---|---|---|
| src/store/index.ts:? | 循环依赖 | P1 | line | src/store/index.ts -> src/canvas/index.ts -> src/store/index.ts | f3a5289629d79238 |
```

## 已知设计缺口（如实标注，未在此处编造数据）

- **commit sha**：G1 `state/findings-<date>.json` 契约的记录 schema 不含 commit 字段，`issue-gate.mjs` 因此无法诚实推导出目标仓（mivo-canvas-plugin）的 commit sha。默认写 `unknown`；可用 `--commit <sha>` 显式传入（例如由 Trae 自动化脚本用 `git -C <mivo-canvas-plugin 本地路径> rev-parse HEAD` 取得后传入）。**若 `--send` 时存在待单发 issue 却未提供 `--commit`，会 fail-closed 直接拒绝发送**（2026-08-01 新增：不再允许把 "unknown" 真的发出去）。
- **汇总对账行**：若 `state/findings-<date>.json` 同目录结构下找不到对应的 `reports/nightly-<date>.md`（或未显式传 `--report`），汇总正文首行会写成 `[回退] G1 对账行缺失（未找到 <path>），本汇总仅基于 findings.json 的记录`，不会编造「派 N / 成 M / 败 K / n_a J」数字。dry-run 下允许这样预览，但**若 `--send` 时存在待汇总内容而对账行仍是回退占位，同样 fail-closed 拒绝发送**。
- **verify 命令的可执行性**：`verify` 字段来自审计脚本对被审计仓库内容的自动提取（文件名、grep 片段等），属于不可信输入。G2 只保证渲染时不会破坏 Markdown 结构（动态围栏长度、脱敏疑似密钥值），但不保证内容本身对 shell 是安全的——正文里附了一句提醒，操作者粘贴执行前应自行确认。
- **单条汇总 issue 的体量上限（round-3 已加 fail-safe，仍非完整分片方案）**：G1 真实一夜产出可能有上千条 finding 打包进**同一条**汇总 issue，若不设上限渲染出的正文能到 30+ 万字符，远超 GitHub issue 正文的实际上限（约 65536 字符）。round-3 起 `renderSummaryIssue` 按 60000 字符安全预算截断表格行——超出后停止追加新行，顶部对账区与正文尾部都会标注「因体量限制省略 N 行，完整清单见当日 findings JSON（路径）」，不静默丢弃；`--send` 时另有 65000 字符的防御性硬上限，超出直接拒发（exit 2，理论上不会触发，因为渲染层已先截断）。这只是 fail-safe，不是完整分片方案——是否需要按维度/按数量分片成多条汇总 issue，仍是未落地的契约升级建议。
- **部分发送失败的退出码（round-3 D-C）**：`--send` 时只要存在任何发送失败（单发或汇总，包含全部失败——成功数 0 也算部分失败的极端），退出码是 **3**，不是 0。已成功创建的 issue 已逐条落盘去重（`markSeen`+`save`），重跑本命令只会补发失败项，不会重复创建。dry-run 不受影响，恒为 0（或用法/环境错误对应的 1/2）。
