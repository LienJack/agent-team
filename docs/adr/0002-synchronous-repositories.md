# 0002 同步的 repository ports 與 `atomic()`

狀態：採用（phase 1）

**決定**：所有 repository 方法都是同步的；`Store.atomic(fn)` 的 `fn` 必須同步，回傳 thenable
就回滾並丟錯。巢狀呼叫併入外層交易。

**理由**：spec 指定 SQLite（`node:sqlite` 或 `better-sqlite3`），兩者都是同步 API。同步交易內不可能
插進其他 await，engine 是單一寫入者，於是「讀 → 檢查 → 寫」在一個交易內就是原子的，不需要鎖。
非同步回呼會讓別的工作在交易中間插隊，反而要處理交錯。

**後果**：

- 所有 IO（runner、git、檢查、通知）都在交易外做；effect 的 handler 先做 IO，再回傳一個 finalizer，
  由 executor 在「刪除 effect」的同一個交易裡套用。
- 套用結果時一律在交易內重新讀取並檢查柵欄（`task.current_run_id`、`run.state`、`task.version`）。
- 記憶體版以整份快照實作回滾；SQLite 版用 `BEGIN IMMEDIATE`／`COMMIT`／`ROLLBACK`（可用 savepoint
  處理巢狀，契約不依賴巢狀內部吞掉例外後的狀態）。
- 契約測試 `runRepositoryContract()` 覆蓋回滾（含所有 repository）、拒絕非同步回呼、樂觀鎖、唯一鍵。
