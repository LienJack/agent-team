# 0013 看板即時資料與等待 leader 回覆

狀態：採用（整合收尾；補充 spec §9、§11、§13）

**問題**：卡片要顯示執行者、耗時、費用與 commit，原本每張卡各發一次 `GET /tasks/:id`；日誌尾段與頂部的 leader
狀態沒有事件可訂閱，只能輪詢；一個 leader turn 最長 10 分鐘，而 Node 內建 fetch（undici）等回應標頭最多 300 秒，
`team ask` 會被切斷。

**決定**：

- `GET /state` 的每個任務是 `BoardTask` = task + `latest_run`（目前的 run，否則最新的：別名、runner、狀態、費用、
  用量、起訖時間）+ 目前 workspace 的 `head_sha` + `run_totals`（run 數、費用合計、用量合計、已結束 run 的總時長）。
  執行中的 run 自己的時間由看板以 `now - started_at` 補上。卡片不再發請求；`commit.created`、`workspace.*` 會重讀快照。
- 事件（持久，SSE 的游標照舊）：
  - `leader.status_changed { state, available, reason, until }`：idle／busy／offline 或可用性改變時寫一筆
    （與上一筆相同就不寫；啟動時只記基準不寫）。
  - `run.log_advanced { offset }`（`run_id` 在信封裡，`task_id` 為 null）：伺服器每 2 秒 stat 一次執行中 run 的
    `events.jsonl`（沒有就 `stderr.log`），變長才寫，所以每個 run 每 2 秒最多一筆；不喚醒排程器。core 只提供
    `engine.recordRunLog()`，檔案 IO 在 `apps/server/src/run-log-watch.ts`。
  - 看板的事件→查詢對照表 `EVENT_QUERIES` 以 `satisfies Record<EventType, Mapper>` 宣告：schema 新增事件型別時，
    型別檢查只會在這一個地方失敗。
- `POST /leader/messages`：`wait: false` 存好、排入佇列就回 `{ pending: true, message_id, leader }`（leader 停用或
  不可用也不丟錯，`leader` 說明原因）；`wait: true`（預設）最多等 `leader.reply_wait_ms`（預設 240 秒，上限 290 秒，
  低於 undici 的 300 秒），逾時回 `pending: true` 而不是錯誤；仍保留「不可用時 503」。新增
  `GET /leader/messages/{id}` → `{ message, reply, leader }`（leader 身分不可用）。
- `askLeader()`（`packages/client`）：POST `wait: true`，pending 就每 2 秒查一次 `GET /leader/messages/{id}`，直到有回覆；
  輸入已不是 `new` 卻沒有回覆（turn 失敗）、或 leader 因停用／未安裝／未登入／額度而不可用時停止並說明；
  訊號中止（Ctrl-C、MCP 取消）時丟 `AskAbortedError`，訊息照樣保留並在之後回覆。`team ask` 與 MCP `ask_leader`
  共用它（MCP 有 progressToken 時送進度通知）。網頁聊天用 `wait: false`，回覆經 `leader.reply` 事件重讀歷史。

**後果**：快照多了每個任務的 run 摘要（一次讀所有 run，與任務數成正比）；事件表多了每個執行中 run 每 2 秒最多一筆的
日誌事件，以及每個 leader turn 兩筆狀態事件。
