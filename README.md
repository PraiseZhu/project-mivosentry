# Project MivoSentry

Trae@macmini 哨兵管道：mivo 仓夜间机械审计、锚点盘点、issue 闸门（只发现不修改，产物为脚本+提示词+runbook）。

`secret-pattern` 对测试路径（`*.test.*` / `__tests__/` 等）的凭据命中是 skip + 计数，**不写入 findings**，因此也不会交给 bug-doctor 记 manual-ticket。危险 API（eval / dangerouslySetInnerHTML）仍产出。生产路径凭据命中仍为 P1。

详细约定见 [CLAUDE.md](./CLAUDE.md)，版本管理见 [VERSIONING.md](./VERSIONING.md)。
