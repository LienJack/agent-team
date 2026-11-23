# 0024 區網監聽埠不驗證：移除區網密碼、來源檢查與「區網不能建專案」

狀態：採用（擁有者 2026-11-22 的決定；改寫 spec §11、§13、§14。取代 ADR 0006 的「LAN session 168 小時」、ADR 0014
決定四的「區網 session → human」與其剩餘風險中的區網密碼、ADR 0020 列出的 `TEAM_LAN_PASSWORD`、ADR 0021 的「本服務的
API 都要權杖」）

**決定**：擁有者 2026-11-22 明確要求，分三步，同一天定案：

1. **移除區網密碼**：`.env` 的 `TEAM_LAN_PASSWORD` 與「未設定就在啟動時產生一組並印在終端機」的備用做法、
   `POST /auth/login` 與看板的登入頁、HMAC 簽章的 session cookie、同一來源連續失敗的鎖定、`service.json` 的
   `lan.lockout_failures`／`lan.lockout_minutes`／`lan.session_hours`、錯誤碼 `locked`、`team doctor` 的
   `env.TEAM_LAN_PASSWORD` 與「secret in the process environment」警告裡的這個變數、client 的 `login()`、
   OpenAPI 的 `sessionCookie` 與 `/auth/login`、看板的登入狀態（`auth`／`session`）。
2. **區網與本機 operator 權限相同**（「信任區網」）：拿掉 `x-local-only` 標記、`isLocalOnly`、區網路由守衛與錯誤碼
   `lan_forbidden`。區網現在可以建專案（`POST /api/projects`）與 `leader reset`。看板沒有新增「建專案」的介面：
   只在 API／CLI 層級。
3. **不做任何瀏覽器端防護**：移除 `Origin`／`Sec-Fetch-Site` 檢查與 `lan.allowed_origins`；不加原本提議的 `Host`
   檢查（`lan.allowed_hosts`，擋 DNS rebinding），也不加「寫入一律 JSON」的替代規則。協調者事先向擁有者說明：沒有
   登入之後，這些檢查是唯一擋住「外部網頁經由網路上的瀏覽器操作看板」的東西；擁有者知情後仍選擇移除。

**現在的行為**：區網監聽埠（預設 `0.0.0.0:4518`）沒有驗證、沒有來源檢查、沒有主機檢查。每個請求都是人（`human`），
訊息 `source`／回答 `via` 記為 `web`，冪等的 caller 是 `lan`（所有區網用戶端共用；Idempotency-Key 由用戶端隨機產生）。
綁定非 loopback 位址時，`team serve` 另印一行提醒「看板沒有任何驗證、來源或主機檢查」。

**還在的**（都不是區網防護）：

- 本機監聽埠的 operator 權杖（`listener.json`）與 leader 權杖不變：那是 CLI／MCP／leader 的身分，leader 的路由守衛照舊。
- 不送任何 CORS 標頭（其他網站的網頁讀不到回應，除非用 DNS rebinding）；`secureHeaders`（含
  `Cross-Origin-Resource-Policy: same-origin`）照舊。
- 請求解析照舊：宣告了 JSON 本文的路由（`@hono/zod-openapi` 的 media-type gate）拒絕其他 Content-Type，回 400
  `bad_request`。這是原有行為，不是新加的防護；沒有宣告本文的路由不檢查 Content-Type。
- `lan.enabled`、`lan.host`、`lan.port`。

**這代表什麼（剩餘風險，誠實說明）**：

- **同一網路的任何裝置**都能做人能做的一切：派工、驗收自己派的工、退回、回答待決事項（含 high 風險）、改派、讀 run
  日誌與 leader 對話、刪專案記憶、`leader reset`，以及建專案——專案的 `checks` 是任意指令，`allow_network` 也由建立者
  決定。任務與機器檢查會在這台 Mac 上執行程式碼（在沙箱內，ADR 0014、0019），等於把一個受沙箱限制的 shell 開給整個
  網路。區網是未加密的 HTTP。
- **網路上任何瀏覽器裡開著的網頁**（不只是區網裝置自己的網頁；任何網站都可能）：
  - 不需預檢的跨站請求（表單送出、`no-cors` 的 `fetch`）會送達並生效。宣告了 JSON 本文的路由會擋下非 JSON 的本文
    （上面的 media-type gate），所以這類請求至少能做：不帶本文地呼叫任務的 `queue`／`cancel`／`retry`／`approve`
    （本文選填），以及沒有宣告本文、任何 Content-Type 都收的 `leader reset` 與刪記憶項（2026-11-22 以一次性的
    行程內請求確認：跨站 `text/plain` 的 `leader reset` 回 200、不帶本文的 `cancel` 進到處理函式、`text/plain` 的
    `POST /api/attention` 回 400）。任務與記憶的 id 是隨機的，單靠這種請求讀不到回應、猜不到 id；`leader reset`
    不需要 id。
  - **DNS rebinding**（攻擊者的網域改解析到這台 Mac 的區網 IP 或 `127.0.0.1`）讓網頁變成「同源」：能讀回應、能送
    JSON，也就是能派任意任務、建帶任意 `checks` 的專案。沒有 `Host` 檢查擋它。
  - 把 `lan.host` 綁到 `127.0.0.1` 擋不住這兩種：這台 Mac 瀏覽器裡的網頁仍連得到 `127.0.0.1:4518`。完全擋住只有
    `lan.enabled: false`。
  - 部分瀏覽器對「公開網站連區網或本機位址」另有限制或權限提示；那是瀏覽器自己的行為，本服務不依賴它，也沒有實測。
- **worker 與機器檢查**：沙箱拒絕連服務自己的埠（本機與區網監聽埠、任何位址），現在是 worker／檢查與「人」的權限之間
  唯一的屏障（之前還要密碼）。ADR 0014 記錄 claude worker 連這台電腦的區網 IP **沒有實測**。調研 run 的 WebFetch
  （ADR 0021）若連得到這台電腦的區網 IP，可以讀（GET）看板資料與 run 日誌；GET 不改狀態。
- **升級**：`service.json` 是嚴格 schema。還留著 `lan.lockout_failures`、`lan.lockout_minutes`、`lan.session_hours`
  或 `lan.allowed_origins` 的檔案，啟動時會以 `lan: Unrecognized keys: …` 失敗：刪掉這幾個鍵即可（本 repo 的
  `config/service.json` 已更新）。`.env` 裡留著的 `TEAM_LAN_PASSWORD` 不再被讀取，可以刪。

**怎麼限制**：`lan.enabled: false`（關閉看板；CLI／MCP 走本機監聽埠，照常要權杖），或 `lan.host: "127.0.0.1"`（只有
這台電腦；這台電腦上的其他使用者、行程與瀏覽器裡的網頁仍然可以）。這是僅有的兩個開關。需要更多時，自行在前面放一個
有驗證的反向代理並把 `lan.host` 綁 `127.0.0.1`（v1 不做）。

**驗證**：`apps/server/src/auth/auth.test.ts`（區網不帶任何憑證讀寫都成功；舊的 `/auth/login` 回 404、沒有
`Set-Cookie`；外來 `Origin`、`Sec-Fetch-Site: cross-site` 與任意 `Host` 都照常回應；區網可建專案、`leader reset`、
回答待決事項且記為 `web`）、`service.test.ts`（真實監聽埠不登入就能讀、啟動輸出沒有密碼；綁非 loopback 才印提醒）、
`actors.test.ts`（區網一律 `web`）、`openapi.test.ts`（沒有 local-only 路由、只有 `bearerAuth`、所有路徑都在 `/api`
下）、`config.test.ts`（舊的 `lan.*` 鍵被拒）、看板的 `app.test.tsx`（不登入直接看到看板）與 Playwright 冒煙（沒有
登入步驟）。
