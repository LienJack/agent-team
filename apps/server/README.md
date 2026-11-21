# @agent-team/server

Hono 服務（spec §9–§11）：本機與區網兩個監聽埠、Bearer 與密碼 session 驗證、來源檢查與鎖定、冪等、SSE、
leader 與 hub（phase 2 為 stub；`GET /api/resume` 已是真實摘要）。

- `src/main.ts`：組裝根（唯一 import db／runners／git 的檔案）；`AGENT_TEAM_FAKE_RUNNERS=1` 用假 runner，
  `AGENT_TEAM_CONFIG_DIR` 改指設定目錄。
- `src/env.ts`：唯一的 `.env` 讀取函式，一次回傳一個變數，process env 優先，不記錄值。
- 其餘模組只依賴 ports：`createService(deps)`、`createApp(ctx, { listener })`；測試用 `src/testing/harness.ts`
  （記憶體 store + core 的假 ports）。
