# @agent-team/cli

`team` 指令（spec §12）：`@agent-team/client` 的薄包裝，不放業務邏輯。讀 `DATA/run/listener.json` 連線；
輸出簡短，`--json` 給機器；結束碼 0 成功、1 業務錯誤、2 用法或連線錯誤。

`team serve` 以子行程啟動 `apps/server/dist/main.js`（或 `AGENT_TEAM_SERVER_ENTRY`）；
`AGENT_TEAM_ACTOR=leader` 讓呼叫以 leader 身分送出（不佔保留給人的槽位）。
