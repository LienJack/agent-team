# @agent-team/server

Hono 服務（spec §9–§11）：本機與區網兩個監聽埠、Bearer 與密碼 session 驗證、來源檢查與鎖定、冪等、SSE、
leader（`src/leader/`：一個無頭 Claude 對話，序列處理、事件合併、壓縮與現況摘要、額度與登入處理）與
Grok 中樞（`src/hub/`：`grokmsg` 收發、outbox、合併與安靜時段、`hub_summarizer` 整理；預設關閉）。

- `src/main.ts`：組裝根（唯一 import db／runners／git 的檔案）；`AGENT_TEAM_FAKE_RUNNERS=1` 讓 worker 用假 runner
  （leader 另由 `service.json` 的 `leader.enabled` 控制），`AGENT_TEAM_CONFIG_DIR` 改指設定目錄。
- `src/app/board.ts`：`GET /api/state` 快照（每個任務附最近一次 run、`head_sha`、run 合計）；
  `src/run-log-watch.ts`：執行中 run 的日誌變長時寫 `run.log_advanced` 事件（每個 run 每 2 秒最多一筆）。
- `src/env.ts`：唯一的 `.env` 讀取函式，一次回傳一個變數，process env 優先，不記錄值。
- 其餘模組只依賴 ports：`createService(deps)`、`createApp(ctx, { listener })`；測試用 `src/testing/harness.ts`
  （記憶體 store + core 的假 ports）。
- leader 的 `team` 是 `DATA/leader/bin/team`（以 leader 身分執行本 repo 建置好的 CLI）；leader 身分不能讀 run 日誌、
  對話紀錄（含 `GET /api/leader/messages/{id}`）、事件串流，也不能 `team ask`／`team leader reset`（403）。
