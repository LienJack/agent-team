# @agent-team/protocol

API 路由合約（spec §11）：`@hono/zod-openapi` 的 `createRoute`（不含處理函式），依資源分在 `src/routes/`，
DTO 來自 `@agent-team/schema`。`buildOpenApiDocument()` 產生 OpenAPI 3.1 文件，提交為 `openapi.json`。

- `pnpm --filter @agent-team/protocol generate`：重寫 `openapi.json`（以 oxfmt 格式化）。
- `pnpm --filter @agent-team/protocol check:generated`：提交的檔案與產生結果不同就失敗（`src/openapi.test.ts` 也檢查）。
- `@agent-team/protocol/constants`：不含執行期依賴的常數（API 前綴、錯誤回應元件名稱），給瀏覽器端使用。
