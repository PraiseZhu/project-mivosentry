# MivoCanvas 锚点盘点（G3）

- 生成时间：2026-08-01T14:15:30.178Z
- 目标仓：`/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
- 只读自检：ok（本工具输出写入后，对比跑前/跑后 `git -C <repo> status --porcelain` 一致，长度 22 字符）
- coverage 探测：检测到 coverage 能力：CI workflow（ci.yml）；但既有产物 coverage/coverage-summary.json 判定为 stale/partial，不采信（产物含 5 个文件、0 个位于 src/ 下（示例：server/persist/backend.ts, server/persist/migrations.ts, server/persist/pgBackend.ts, server/persist/pgConfig.ts, server/persist/pgPermissionBackend.ts），与本工具模块判据（src 一级目录）无交集；产物 mtime（2026-07-31T17:04:39.962Z）早于当前 HEAD 提交时间（2026-08-01T19:12:20+08:00））→ 本次仍按存在性判据计算，pct 列填 n/a（需先手动跑一次 coverage 脚本/CI job 再重跑本工具）
- bench exclude 校验：已核实 vitest.config.ts 的 bench exclude 项与本工具一致：`**/*.bench.test.ts`

## 判定逻辑（机械，源码原样取自本脚本 computeVerdict.toString()，不手抄，不会与实际逻辑漂移）

```js
function computeVerdict(testFileCount, expectCount) {
  if (testFileCount === 0) return 'danger'
  if (expectCount < testFileCount * 3) return 'weak'
  return 'safe-candidate'
}
```

注：`**/*.bench.test.ts` 不计入 test 文件数/断言数——已核实与目标仓 `vitest.config.ts` 的 exclude 规则完全一致，bench 已被移出 `test:unit` / required gate，破坏 bench 覆盖的逻辑不触发合并阻断报警。

## 模块表

| 模块 | 测试文件数 | 断言数(expect) | coverage%(有则填) | skip/only残留 | 判定 |
|------|-----------|---------------|-------------------|---------------|------|
| `src/agent` | 9 | 427 | n/a | 0 | safe-candidate（待终审） |
| `src/app` | 6 | 121 | n/a | 0 | safe-candidate（待终审） |
| `src/canvas` | 48 | 1676 | n/a | 0 | safe-candidate（待终审） |
| `src/i18n` | 2 | 19 | n/a | 0 | safe-candidate（待终审） |
| `src/kernel` | 12 | 817 | n/a | 0 | safe-candidate（待终审） |
| `src/lib` | 50 | 2814 | n/a | 0 | safe-candidate（待终审） |
| `src/model` | 7 | 188 | n/a | 0 | safe-candidate（待终审） |
| `src/render` | 25 | 927 | n/a | 0 | safe-candidate（待终审） |
| `src/store` | 34 | 1703 | n/a | 0 | safe-candidate（待终审） |
| `src/types` | 0 | 0 | n/a | 0 | danger |

## 三区占比汇总

| danger | weak | safe-candidate（待终审） | 模块总数 |
|--------|------|--------------------------|----------|
| 1 (10.0%) | 0 (0.0%) | 9 (90.0%) | 10 |

