# @agent-team/core

領域邏輯，不碰 IO（只依賴 `@agent-team/schema`）：ports、engine（排程、派工、核對、審查與升級、冷卻與熔斷、復原、清理）、記憶體版 `Store`、冪等輔助。

- 要實作的介面在 `src/ports/`（`Store`／repositories、`Runner`、`RunnerRegistry`、`GitPort`、`CheckExecutor`、`ProcessControl`、`Clock`、`IdGen`、`Notifier`、`LeaderNotifier`、`EventPublisher`、`MemoryPort`）。
- 專案記憶（spec §18、ADR 0023）：`src/engine/project-memory.ts`（組文字、`memory.write` effect，鍵＝來源 id）、
  `memory-read.ts`（派工前的搜尋、失敗的冷卻與 `memory.unavailable`）、`prompt-memory.ts`（「專案記憶」資料區塊）、
  `memory-commands.ts`（入口與 actor 規則）；`@agent-team/core/testing` 的 `FakeMemory`。
- 調研任務（spec §17）：`src/engine/research.ts`（建立、`research_refs` 核對、回執套用）、`prompt-research.ts`（只有題目的
  調研提示、實作提示的「參考調研」區塊）；派工不建 worktree，`resolveRole` 只取 `supports.webSearch` 的 runner。
- 指令帶 `Actor`：approve、reject、回答待決事項、改派、建專案、基底漂移決定只接受 human；leader 的重試有預算（ADR 0014）。
- `@agent-team/core/testing`：`createTestEngine()`、`FakeRunner`、`FakeGit`、`ManualClock`，以及 `runRepositoryContract()`（SQLite 版必須跑的同一組契約測試）。
