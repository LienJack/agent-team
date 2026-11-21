# 0010 `start_unknown` 的判定

狀態：採用（phase 2 收尾；補充 ADR 0005）

**定義**：子行程已啟動（codex：SDK 已呼叫、wrapper 已啟動 codex），但在**第一個 agent 事件**之前連線或行程就結束，
而且**無法證明沒有開始工作**。第一個 agent 事件：claude 的 `system`（帶 session_id）、codex 的 `thread.started`、
dsh 的 `session`。

**runner 的規則**（`unstartedResult`、`startTimeoutResult`，三個 runner 共用）：

- `hooks.onStarted` 在第一個 agent 事件時才呼叫（帶 spawn 時的 pid 與 session id），不再在 spawn 時呼叫。
- 第一個事件之前結束時：
  - 無法 spawn → `crash`（確定沒啟動，可安全重送）；
  - CLI 自己說明了原因 → 維持原分類：`auth`、`rate_limit`、參數／用法錯誤（`crash`）、dsh 在 session 前的 `error`
    事件或 codex 的 `error`／`turn.failed` 事件（`crash`）；
  - 我們取消的 → `cancelled`；
  - 其他（被 signal 殺掉、無說明的非零結束、0 結束但沒有任何事件、串流中斷、等到逾時都沒有事件）→ `start_unknown`。
- 第一個事件之後的失敗照一般分類（`crash`、`timeout`…）。

**engine**：`start_unknown` 一律不自動重送：run 結束（仍是 `starting` 時為 `start_unknown`，已標 `running` 時為
`failed`）、任務 `blocked`、開一筆 attention、計入 runner 熔斷。已在 `onStarted` 之後收到的 `start_unknown` 也走同一條路。

**驗證**：`packages/runners/src/start-unknown.test.ts` 對三個 runner 用照劇本的假 CLI 驗證上述每一類，並把真 runner
接上 engine，確認只 spawn 一次、任務阻塞、待決事項一筆。
