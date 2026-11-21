# @agent-team/cli

`team` 指令（spec §12）：`@agent-team/client` 的薄包裝，不放業務邏輯。讀 `DATA/run/listener.json` 連線；
輸出簡短，`--json` 給機器；結束碼 0 成功、1 業務錯誤、2 用法或連線錯誤。

`team serve` 以子行程啟動 `apps/server/dist/main.js`（或 `AGENT_TEAM_SERVER_ENTRY`）；
`AGENT_TEAM_LISTENER_FILE` 改讀另一個 listener 檔（leader 的 shim 指向 `DATA/leader/listener.json`，裡面是 leader 權杖；身分由伺服器依權杖判定，ADR 0014）。

`team ask` 等到 leader 回覆為止（伺服器等滿 `leader.reply_wait_ms` 仍沒有回覆就回 pending，接著每 2 秒查
`GET /api/leader/messages/{id}`）；Ctrl-C 只停止等待（結束碼 130），訊息保留、之後照樣回覆。
`team task reassign <id> <role>` 先用 `GET /api/roles` 檢查角色存在且啟用；`team roles` 列出全部角色。
