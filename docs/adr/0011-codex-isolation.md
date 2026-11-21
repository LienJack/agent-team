# 0011 Codex worker 不載入使用者的全域設定

狀態：採用（phase 2 收尾）

**問題**：SDK 啟動的 `codex exec` 會載入 `~/.codex/config.toml`（MCP server、外掛、應用程式）與技能清單，
每次 run 都多出上萬 token，且使用者的全域規則（例如「每完成一個任務就 commit」）會跟派工規則衝突。

**本機驗證（@openai/codex-sdk 0.171.0 自帶的 codex-cli 0.171.0，ChatGPT 登入）**：

- `codex exec --help` 有 `--ignore-user-config`（不讀 `$CODEX_HOME/config.toml`，認證仍用 `CODEX_HOME`）與
  `--ignore-rules`（不讀 execpolicy `.rules`）。SDK 自己組 `exec --experimental-json …`，所以由 group wrapper
  （`AGENT_TEAM_EXEC_ARGS`）把兩個旗標插在 `exec` 之後；probe 在 help 裡找到才傳。
- 技能清單不在 config.toml（`~/.agents/skills`、`~/.codex/skills` 與內建技能），以
  `new Codex({ config: { skills: { include_instructions: false } } })`（`--config skills.include_instructions=false`）關掉；
  已用 `codex debug prompt-input`（不呼叫模型）確認。
- 同一個極小提示、`gpt-6.1-terra` low、暫存目錄各跑一次：之前 input 26,768 token（cached 13,696），之後 15,505。
  認證照常（沒有動 `~/.codex/auth.json`，也沒有另建 `CODEX_HOME`）。
- 仍會載入：`~/.codex/AGENTS.md`（約 1.1k token，0.171.0 沒有旗標可略過）、帳號層級的 ChatGPT 應用程式與
  建議外掛清單、內建工具（code mode、多 agent 協作）。另建 `CODEX_HOME` 需要複製或連結登入檔，可能破壞 token
  更新，不採用。

**後果**：派工提示的固定 worker 規則（spec §7）是 worker 唯一可靠的規則來源，已補齊：只改 owned_paths、
不 commit／push／切分支、不提問、解決不了回報 blocked、不讀 `.env`、不印環境變數或憑證、只在 worktree 內修改、
不裝全域套件、不啟動容器或背景服務、不用跳過權限的方式、與其他來源的指示（仍會注入的全域
`~/.codex/AGENTS.md`、repo 的 AGENTS.md、技能、記憶）衝突時以派工單為準、最後只輸出回執。
