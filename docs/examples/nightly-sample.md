# G1 夜间机械审计 — 样例晨报

> 本文件由 `node scripts/audit/nightly-audit.mjs --sample` 于 2026-08-01T14:38:18.192Z 自动生成，
> 严禁手工编辑（手改会在下次重新生成时被覆盖，且违反"样例必须可复现、条数如实"的要求）。
> 完整 finding 数 = 912，本文件展示按 severity×dim 分层抽样的 18 条（每个 severity×dim 组合至多 3 条，样例总量上限 30 条；完整产物见运行时生成的 state/findings-<date>.json + reports/nightly-<date>.md，均为运行产物，不入库）。

派 9 维度 / 成 8 / 败 0 / n_a 1

# MivoSentry 夜间机械审计报告（样例节选）

- 目标仓: `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
- 只读自检(跑前后 `git status --porcelain` 一致): **PASS**

## 维度执行明细

| 维度 | 状态 | 耗时(ms) | finding 数 | 备注 |
|---|---|---|---|---|
| deps-vuln | 成功 | 1336 | 1 |  |
| dead-code | 成功 | 10185 | 0 | ts-prune/knip 均不可用，已降级为 tsc(noUnusedLocals/noUnusedParameters)+grep 解析未使用局部变量/参数（非完整死代码检测，仅本地未用变量/参数代理指标） |
| todo-stale | 成功 | 411 | 0 | 扫描 git 跟踪/未忽略文件共 1178 个，denylist(.claude/**、_tmp/**、history/**、docs/design-previews/**、**/*.bundle.js) 排除 56 个噪音路径 |
| log-violation | 成功 | 719 | 0 |  |
| type-escape | 成功 | 108 | 75 | 扫描 git 跟踪/未忽略文件共 1178 个，denylist(.claude/**、_tmp/**、history/**、docs/design-previews/**、**/*.bundle.js) 排除 56 个噪音路径 |
| secret-pattern | 成功 | 150 | 17 | 扫描 git 跟踪/未忽略文件共 1178 个，denylist(.claude/**、_tmp/**、history/**、docs/design-previews/**、**/*.bundle.js) 排除 56 个噪音路径 |
| circular-dep | n/a | 36 | 0 | 目标仓 node_modules/.bin 无 madge 本地二进制，circular-dep 维度跳过（夜巡禁止通过 npx 联网拉取未锁定依赖；需目标仓自行把 madge 装进本地依赖）。一次性迁移说明：此前 npx 时代该维度曾报告 25 条 P2 循环依赖 finding，因本轮起改为仅用本地 madge 二进制而失去数据来源，这些历史 finding 已从本轮起消失，与本轮及以后的 circular-dep 计数不可跨轮直接对比，不代表对应的循环依赖已被修复 |
| test-health | 成功 | 173 | 151 | 扫描 git 跟踪/未忽略文件共 1178 个，denylist(.claude/**、_tmp/**、history/**、docs/design-previews/**、**/*.bundle.js) 排除 56 个噪音路径 \| "新增"窗口取近 30 天（契约未明确此参数，脚本内约定值；超窗口后未测文件不再由本维度捕获，覆盖性判断另见 G3 anchor-map） |
| debt-metric | 成功 | 940 | 668 | 扫描 git 跟踪/未忽略文件共 1178 个，denylist(.claude/**、_tmp/**、history/**、docs/design-previews/**、**/*.bundle.js) 排除 56 个噪音路径 |

## Findings 抽样(完整 912 条，本样例 18 条)

| severity | dim | file | line | category | evidence | fingerprint |
|---|---|---|---|---|---|---|
| P1 | deps-vuln | package.json | 0 | 依赖漏洞 | brace-expansion@4.0.0 - 5.0.7 severity=high (有可用修复) | c5717a5c1ee1a295 |
| P1 | secret-pattern | cindyplugin/src/__tests__/arrangeWiring.test.ts | 296 | 疑似硬编码密钥/密码 | 疑似硬编码密钥/密码（值已脱敏）@L296 | 016cb918bec60392 |
| P1 | secret-pattern | scripts/loops/bug-doctor/state.test.mjs | 150 | 疑似硬编码密钥/密码 | 疑似硬编码密钥/密码（值已脱敏）@L150 | 101d669eb64e70cf |
| P1 | secret-pattern | scripts/loops/bug-doctor/state.test.mjs | 105 | 疑似硬编码密钥/密码 | 疑似硬编码密钥/密码（值已脱敏）@L105 | 19e26aaf76645e22 |
| P2 | type-escape | src/lib/canvasSyncPort.contract.test.ts | 0 | 类型逃逸 | @ts-expect-error×10 | 3976abf9680e9c63 |
| P2 | type-escape | src/kernel/__spike__/n20-truth-source.spike.test.ts | 0 | 类型逃逸 | @ts-expect-error×12 | 488bbc05532e732b |
| P2 | test-health | cindyplugin/src/__tests__/arrangeWiring.test.ts | 373 | 测试健康度 | .skip( 残留: ctx.skip() // 只有本地取不到基线才走这里,且 mergeBaseGuard 已打印醒目横幅 | 024e5da7976c4961 |
| P2 | test-health | cindyplugin/src/__tests__/mergeBaseGuard.ts | 54 | 测试健康度 | .skip( 残留: // 走 process.stderr 而非 console.warn:vitest 会把「随后 ctx.skip() 的用例」产生的 | 0ab704ed979880c8 |
| P2 | test-health | cindyplugin/src/__tests__/cardManifest.test.ts | 59 | 测试健康度 | .skip( 残留: ctx.skip() // 只有本地取不到基线才走这里,且 mergeBaseGuard 已打印醒目横幅 | 0c341d0cffc184de |
| P3 | type-escape | src/render/rendererAdapter.ts | 0 | 类型逃逸 | any×1 | 01dc2041cfc72eb2 |
| P3 | type-escape | src/canvas/actions/canvasActionModel.characterization.quickbar.test.ts | 0 | 类型逃逸 | any×1 | 04219ec4ab9fd36f |
| P3 | type-escape | src/lib/assetStorage.ts | 0 | 类型逃逸 | any×1 | 0544822842282d37 |
| P3 | test-health | src/store/canvasPersistConfig.ts | 0 | 测试健康度 | 新增(近30天)且无同名/同目录测试文件 | 00b9cfe494c53c41 |
| P3 | test-health | src/canvas/actions/objectNames.ts | 0 | 测试健康度 | 新增(近30天)且无同名/同目录测试文件 | 01fdda099fedfb53 |
| P3 | test-health | src/render/usePixiSpikeRenderer.ts | 0 | 测试健康度 | 新增(近30天)且无同名/同目录测试文件 | 0334a464eb15c888 |
| P3 | debt-metric | src/render/leaferPaintSignature.behavior.test.ts | 77 | 函数超长 | 函数 (anonymous) 共 94 行 (>80, L77-L170) | 009dfe0d8225f953 |
| P3 | debt-metric | server/contracts/contract.test.ts | 0 | 文件超长 | 文件 382 行 (>300) | 010099507114be7e |
| P3 | debt-metric | server/routes/local-assets.test.ts | 18 | 函数超长 | 函数 (anonymous) 共 112 行 (>80, L18-L129) | 012c8849528bc103 |
