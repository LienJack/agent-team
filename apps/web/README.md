# @agent-team/web

看板與聊天（spec §13）：React + Vite + Tailwind + TanStack Query + zustand，拖放用 `@hello-pangea/dnd`。
只透過 `@agent-team/client` 存取 API；建置輸出 `dist/`，由服務的區網監聽埠提供（密碼登入、session cookie）。

- `pnpm --filter @agent-team/web build`：產生 `dist/`（服務只在 `dist/index.html` 存在時提供看板）。
- `pnpm --filter @agent-team/web test`：vitest（jsdom，`*.test.ts` 與 `*.test.tsx`；根目錄 `pnpm test` 直接用
  這份 `vitest.config.ts` 當 web project，一樣全部執行）。
- `pnpm test:e2e`（根目錄）或 `pnpm --filter @agent-team/web test:e2e`：建置後跑 Playwright 冒煙（`e2e/`）：以假 runner、
  leader 關閉啟動真的服務（暫存 `AGENT_TEAM_HOME`、設定、`.env`、git repo，只綁 127.0.0.1 的臨時埠）。瀏覽器：
  有 Playwright 自帶的 Chromium 就用它（CI 會安裝），否則用系統的 Google Chrome；`PW_CHANNEL` 可強制指定。
- 卡片的資料全部來自 `GET /api/state`（每個任務附最近一次 run、`head_sha` 與 run 合計），不再每張卡各發請求；
  日誌尾段跟著 `run.log_advanced` 事件更新，聊天用不等待的送出（`wait: false`）。
- `pnpm --filter @agent-team/web dev`：Vite 開發伺服器，`/api`、`/auth` 轉到 `AGENT_TEAM_WEB_PROXY`
  （預設 `http://127.0.0.1:4518`）；需把開發來源加進 `lan.allowed_origins`。

結構：`src/api`（客戶端、查詢、錯誤）、`src/realtime`（SSE 與事件 → 查詢失效對照）、`src/lib`（純邏輯：
拖放規則、格式化、聊天去重、安全的 Markdown）、`src/store`（zustand 介面狀態）、`src/components`。
