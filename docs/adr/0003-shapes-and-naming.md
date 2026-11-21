# 0003 資料形狀與命名

狀態：採用（phase 1）

- 持久化／線上形狀（領域物件、回執、事件、API DTO、設定檔）用 snake_case，與 spec §5、§6、
  `models.json` 相同，API 直接回傳領域物件，不必轉換。Runner 合約照 spec §7 用 camelCase。
- 領域物件的可選欄位是 `T | null`，欄位一定存在：CAS 更新用展開即可清空，SQLite 的 NULL 直接對應。
- 回執的每個欄位都必填（`needs_leader` 無事時為 `""`、finding 的 `line` 無行號時為 `0`），
  JSON Schema 再遞迴補上 `required` 全部欄位與 `additionalProperties: false`，可直接給最嚴格的
  structured output。解析時用一般 object（多出的鍵會被丟掉，不會因此拒收 dsh 的輸出）。
- 設定檔用 strict object：`models.json` 的拼字錯誤在啟動時就失敗；跨欄位檢查（別名、角色、
  升級鏈不得成環、必要角色 impl_A/B/C、review_A/B/C）在 `ModelsConfigSchema` 裡。
- spec 沒有前綴的 id：dispatch 用 `d_`、outbox 用 `o_`。
- `RunErrorKind` 比 spec §7 多一個 `cancelled`（AbortSignal 觸發時回報），其餘照列。
