# @agent-team/core

領域邏輯，不碰 IO（只依賴 `@agent-team/schema`）：ports、engine（排程、派工、核對、審查與升級、冷卻與熔斷、復原、清理）、記憶體版 `Store`、冪等輔助。

- 要實作的介面在 `src/ports/`（`Store`／repositories、`Runner`、`RunnerRegistry`、`GitPort`、`CheckExecutor`、`ProcessControl`、`Clock`、`IdGen`、`Notifier`、`LeaderNotifier`、`EventPublisher`）。
- 指令帶 `Actor`：approve、reject、回答待決事項、改派、建專案、基底漂移決定只接受 human；leader 的重試有預算（ADR 0014）。
- `@agent-team/core/testing`：`createTestEngine()`、`FakeRunner`、`FakeGit`、`ManualClock`，以及 `runRepositoryContract()`（SQLite 版必須跑的同一組契約測試）。
