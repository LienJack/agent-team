# @agent-team/core

領域邏輯，不碰 IO（只依賴 `@agent-team/schema`）：ports、engine（排程、派工、核對、審查與升級、冷卻與熔斷、復原、清理）、記憶體版 `Store`、冪等輔助。

- 要實作的介面在 `src/ports/`（`Store`／repositories、`Runner`、`RunnerRegistry`、`GitPort`、`CheckExecutor`、`Clock`、`IdGen`、`Notifier`、`LeaderNotifier`、`EventPublisher`）。
- `@agent-team/core/testing`：`createTestEngine()`、`FakeRunner`、`FakeGit`、`ManualClock`，以及 `runRepositoryContract()`（SQLite 版必須跑的同一組契約測試）。
