# @agent-team/client

型別安全的 HTTP 客戶端，CLI、MCP、網頁共用。型別由 `openapi-typescript` 從 `packages/protocol/openapi.json`
產生到 `src/generated/`（提交進版控；超過 500 行的介面會拆成數個檔案）。

- `createTeamClient({ baseUrl, token })`：`openapi-fetch` 包裝；會改變狀態的請求自動帶 `Idempotency-Key`，
  連線失敗以同一把鍵重試；錯誤一律丟 `TeamApiError { code, message, hint }`。
- `client.events({ after, onEvent })` / `subscribeEvents()`：SSE（fetch 串流），斷線後以 `after=<lastSeq>` 接續。
- `@agent-team/client/node`：`discoverListener()`、`connectLocal()` 讀 `DATA/run/listener.json`（`AGENT_TEAM_HOME`）。
- `pnpm --filter @agent-team/client generate` / `check:generated`。openapi-typescript 需要 TypeScript 5 的 JS API，
  所以本套件另鎖 `typescript@5.9.3`（只給產生器用；型別檢查仍是根目錄的 TS 7）。
- `askLeader(client, { text, source, signal })`：送出並等 leader 回覆，伺服器回 pending 時改為輪詢
  `GET /api/leader/messages/{id}`；turn 失敗或 leader 不可用時停止並說明，`signal` 中止時丟 `AskAbortedError`
  （`team ask`、MCP `ask_leader` 共用）。
- `randomId()`：`Idempotency-Key` 與 `client_msg_id` 的預設產生器，用 `crypto.getRandomValues`（區網的純 HTTP 頁面沒有
  `crypto.randomUUID`），連 `crypto` 都沒有時退回非加密的亂數（只用來去重，不是秘密）。
