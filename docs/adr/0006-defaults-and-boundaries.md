# 0006 預設值與邊界

狀態：採用（phase 1；phase 2 更新 protocol 一節）

**spec 沒給值的預設**（`config/service.json`，皆可改）：全域並行上限 `max_concurrent_runs = 6`（含保留槽）、
`reserved_human_slots = 1`、`max_attempts = 3`、`effect_max_attempts = 10`、`circuit_open_ms = 10 分`、
`run_timeout_ms = 60 分`、`check_timeout_ms = 15 分`、`tick_ms = 5 秒`、LAN session 168 小時、
服務端提交的作者 `git.author = agent-team <agent-team@localhost>`。埠可設 `0`（由作業系統挑空埠）。
`models.json` 沒有「Codex 額度低」的門檻：`rules.quota.codex_low_utilization` 預設 0.8（耗盡一律算低）。
`when_claude_high` 在 Claude 使用率 ≥ `claude_high_utilization` 或耗盡時套用；兩條規則都成立時
`codex_low_quota` 優先。

**owned_paths 語意**：字面路徑包含自身與其下所有檔案；glob 支援 `*`、`**`、`?`。重疊判斷取兩邊的
字面前綴，一邊是另一邊的路徑前綴即視為重疊；以 glob 開頭或清單為空 = 不確定 = 重疊。

**邊界允許表**（`tools/check-boundaries.mjs`）比 spec「只往上依賴」更嚴：`db`／`runners`／`git` 互不依賴、
`protocol` 只依賴 `schema`、`client` 只依賴 `schema` 與 `protocol`、`cli`／`mcp`／`web` 只依賴 `schema` 與 `client`。

**已解決（phase 2，取代原「未解決」）**：不用 Hono RPC `hc<AppType>`（`AppType` 在 `apps/server`，client 不能依賴
apps）。路由合約（`@hono/zod-openapi` 的 `createRoute`，不含處理函式）放 `packages/protocol`，由它產生
`openapi.json` 並提交；`packages/client` 用 `openapi-typescript` 從該檔產生型別（提交於 `src/generated/`）+
`openapi-fetch`。伺服器以同一批合約註冊處理函式。兩個產生檔由根目錄 `pnpm check:generated`
（protocol → client 的順序）與 CI 檢查漂移。spec §2「型別安全的客戶端」一列即此做法。
