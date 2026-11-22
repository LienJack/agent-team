# @agent-team/server

Hono 服務（spec §9–§11）：本機與區網兩個監聽埠、Bearer 與密碼 session 驗證、來源檢查與鎖定、冪等、SSE、
leader（`src/leader/`：一個無頭 Claude 對話，序列處理、事件合併、壓縮與現況摘要、額度與登入處理）與
Grok 中樞（`src/hub/`：`grokmsg` 收發、outbox、合併與安靜時段、`hub_summarizer` 整理；預設關閉）。

- `src/main.ts`：組裝根（唯一 import db／runners／git 的檔案）；`AGENT_TEAM_FAKE_RUNNERS=1` 讓 worker 用假 runner
  （leader 另由 `service.json` 的 `leader.enabled` 控制），`AGENT_TEAM_CONFIG_DIR` 改指設定目錄。
- `src/app/board.ts`：`GET /api/state` 快照（每個任務附最近一次 run、`head_sha`、run 合計）；
  `src/run-log-watch.ts`：執行中 run 的日誌變長時寫 `run.log_advanced` 事件（每個 run 每 2 秒最多一筆）。
- `src/env.ts`：唯一的 `.env` 讀取函式，一次回傳一個變數，process env 優先，不記錄值。
- `src/memory/`：專案記憶的 MemOS HTTP 實作（spec §18、ADR 0023）：每個請求的 cube id 都檢查前綴、逾時用
  `AbortSignal.timeout`、刪除前先以限定 cube 的查詢證明擁有權、錯誤不帶位址；`memory.enabled` 為 false 時不建立。
  測試用 `src/testing/fake-memos.ts`（loopback 上的假 MemOS）。
- 其餘模組只依賴 ports：`createService(deps)`、`createApp(ctx, { listener })`；測試用 `src/testing/harness.ts`
  （記憶體 store + core 的假 ports）。
- 身分由權杖決定（ADR 0014）：本機監聽埠的 operator 權杖（`DATA/run/listener.json`）與區網 session 是人；leader 專用權杖
  （`DATA/leader/listener.json`）是 leader。leader 的 `team` 是 `DATA/leader/bin/team`（本 repo 建置好的 CLI，
  `AGENT_TEAM_LISTENER_FILE` 指向 leader 的 listener 檔）；leader 身分不能讀 run 日誌、對話紀錄、事件串流，不能驗收、
  退回、回答待決事項、改派、建專案，也不能 `team ask`／`team leader reset`（403）。訊息來源與回答管道只由憑證推導
  （`src/app/origin.ts`，請求內容裡的值忽略）。
- `src/main.ts` 把服務端的拒絕清單（DATA、`.env`）交給 runner 與檢查執行器（沙箱，ADR 0014），並接上復原用的
  `ProcessControl`（ADR 0015）。`src/testing/crash-entry.ts` 只給 `crash-recovery.test.ts` 用（假 claude）。
