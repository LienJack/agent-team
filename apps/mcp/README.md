# @agent-team/mcp

stdio MCP 伺服器，讓 Claude／Codex 桌面版對執行中的 agent-team 服務說話。API 的薄包裝：每個工具只呼叫
`@agent-team/client` 一到兩次，沒有業務邏輯。

連線方式與 CLI 相同：`connectLocal()` 讀 `DATA/run/listener.json`（`DATA` 為 `AGENT_TEAM_HOME`，預設
`~/.agent-team`）。服務沒開時，工具回一行錯誤，請使用者執行 `team serve`。stdout 只有協定訊框，記錄走 stderr；
stdin 關閉或收到 SIGTERM 就結束。

## 工具

| 工具               | 輸入                                     | 說明                                                                                            |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ask_leader`       | `text`                                   | 對 leader 說話（`source: "mcp"`），等到回覆為止，只回傳回覆文字（可被呼叫端取消，訊息仍保留）   |
| `status`           | —                                        | 看板摘要：各欄任務數、執行中任務與執行者、未決事項數、runner 與額度、leader 狀態                |
| `list_attention`   | —                                        | 列出未決事項（id、問題、選項）                                                                  |
| `answer_attention` | `id`, `answer`                           | 回答一筆未決事項（`via: "mcp"`）                                                                |
| `task_action`      | `id`, `action`, `role?`, `note?`         | `queue｜cancel｜retry｜approve｜reject｜reassign`；`reassign` 需要 `role`，`reject` 需要 `note` |
| `add_research`     | `project`, `title`, `question`, `queue?` | 建調研任務（spec §17；`research.mode` 為 `off` 時回錯誤）                                       |
| `show_research`    | `id`                                     | 調研結果：建議、摘要、候選（名稱、連結、授權、適合度）；標明是網頁來的資料、連結未經服務端驗證  |

刻意不提供：執行日誌、對話紀錄、建立專案、任何會回傳大量內容的操作——呼叫端的模型不需要讀 worker 的逐字稿。
唯一的例外是 `show_research`：調研的結果本身就是要給呼叫端看的，但只有截短後的候選清單，不是 worker 的過程。

## 建置與執行

```sh
pnpm --filter @agent-team/mcp build      # 或 pnpm build
node apps/mcp/dist/bin.js                # 正式
pnpm exec tsx --conditions=@agent-team/source apps/mcp/src/bin.ts   # 開發
```

以下用 `/ABS/PATH/agent-team` 代表本 repo 的絕對路徑；若資料目錄不在預設位置，加上
`AGENT_TEAM_HOME`。

## Claude Code

指令形式：

```sh
claude mcp add agent-team -- node /ABS/PATH/agent-team/apps/mcp/dist/bin.js
# 自訂資料目錄：
claude mcp add agent-team -e AGENT_TEAM_HOME=/path/to/data -- node /ABS/PATH/agent-team/apps/mcp/dist/bin.js
```

`.mcp.json` 形式（專案根目錄）：

```json
{
  "mcpServers": {
    "agent-team": {
      "command": "node",
      "args": ["/ABS/PATH/agent-team/apps/mcp/dist/bin.js"],
      "env": { "AGENT_TEAM_HOME": "/path/to/data" }
    }
  }
}
```

## Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.agent-team]
command = "node"
args = ["/ABS/PATH/agent-team/apps/mcp/dist/bin.js"]
env = { AGENT_TEAM_HOME = "/path/to/data" }
```

（沒有自訂資料目錄就省略 `env`。）
