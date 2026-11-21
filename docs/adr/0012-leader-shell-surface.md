# 0012 leader 的 shell 範圍

狀態：採用（整合收尾；補充 spec §9；安全審查修正見最後一節）

**問題**：leader 只有 Bash 一個工具，`--allowedTools` 只放行 `team`，`--permission-mode dontAsk` 拒絕其他指令。
但 Claude Code 會自動核准它內建的唯讀指令（`echo`、`pwd`、限於工作目錄的 `ls`），不經 allow-list。

**決定**（`apps/server/src/leader/args.ts`）：

- allow：只列 leader 用得到的 `team` 子指令——裸指令用精確規則（`Bash(team status)`、`Bash(team doctor)`…），
  帶參數的用前綴規則（`Bash(team task:*)`、`Bash(team attention:*)`、`Bash(team receipt:*)`、`Bash(team --json:*)`…）。
  `serve`、`watch`、`ask`、`leader`、`project` 不在其中（shim 與伺服器另外也會拒絕）。
- deny（`--disallowedTools`，`claude --help` 有列才傳）：約 70 個常見的唯讀、輸出、環境、shell 與直譯器指令，
  每個都有裸指令與 `:*` 兩條規則（`ls`、`cat`、`head`、`grep`、`find`、`echo`、`printf`、`pwd`、`env`、`printenv`、
  `git`、`node`、`python3`、`sh`…）。deny 優先於 allow 與自動核准；有單元測試確認沒有任何 deny 規則能匹配
  `team …`（含 heredoc 形式）。
- 其餘維持：`--tools Bash`、`--safe-mode`、`--strict-mcp-config`、空的 `--mcp-config`、`--restricted`、
  `--permission-prompts none`；工作目錄是 `DATA/leader/cwd`（空目錄）；子行程環境只有 allow-list 的變數
  （PATH、HOME、語系等，沒有任何金鑰或權杖；權杖只在 0600 的 listener.json，由 CLI 讀）。

**本機驗證**（Claude Code 2.1.326，`claude-haiku-5-5`，一次真實 leader turn，走正式的 `leaderArgs()` 與 `team` shim，
對著暫存資料目錄上的服務；工作目錄留下的 transcript 已刪除）：

| 指令                                                              | 結果                             |
| ----------------------------------------------------------------- | -------------------------------- |
| `team status`                                                     | 執行，回傳看板摘要               |
| `team task list`                                                  | 執行，列出草稿任務               |
| `ls`、`ls -la`、`echo hello`、`pwd`、`cat /etc/hosts`、`printenv` | 全部被拒（`permission_denials`） |

探測之後只多加了 `Bash(team doctor:*)`、`Bash(team resume:*)` 兩條前綴規則（讓 `team doctor --json`、
`team resume --json` 也能跑；形式與實測過的 `Bash(team status:*)` 相同），它們本身沒有另外實測。重跑探測：
`TEAM_SMOKE=1` 的 `apps/server/test/smoke/leader.smoke.test.ts` 第三個 turn 涵蓋同一組指令外加 heredoc 的
`team task add`（三個 turn）。

**剩下的範圍（誠實說明）**：

- deny-list 是列舉，不是「除了 `team` 以外全部拒絕」：CLI 沒有否定式或「只允許這些」的 Bash 規則，
  deny `Bash(*)` 又會連 `team` 一起擋掉；hook 能做精確過濾，但 `--safe-mode` 會關掉 hooks。所以 Claude Code
  若把清單以外的某個指令（例如較冷門的唯讀指令、絕對路徑形式 `/bin/ls`）視為唯讀而自動核准，它仍可能執行。
  這次實測沒有涵蓋這些情況（未驗證）。
- 能跑的 `team` 子指令本身由 shim（拒 `--ticket-file`、`serve`、`watch`、`ask`）與伺服器的 leader 身分檢查
  （run 日誌、對話紀錄、事件串流、建專案、reset 一律 403）把關；heredoc 形式的 `team task add` 依賴前綴規則，
  這次實測沒有跑到（未驗證，舊版 `Bash(team:*)` 曾驗證過 heredoc）。
- 可以接受的理由：就算清單外的唯讀指令被放行，能看到的只有空的工作目錄與不含秘密的環境；沒有任何檔案工具
  （`--tools Bash`），`--restricted` 另外不讀使用者／專案設定檔（其中的 allow 規則無法放寬清單）；任務狀態的改變
  全部經過 API 與 engine。

**後果**：新的 `team` 子指令若要給 leader 用，要同時加進 allow-list 與 shim 的檢查；Claude Code 升級時
重跑一次冒煙（haiku；這次單一 turn 的探測花費約 0.002 美元）。

**安全審查修正（ADR 0014）**：shim 不再設 `AGENT_TEAM_ACTOR`，改設 `AGENT_TEAM_LISTENER_FILE=DATA/leader/listener.json`
（leader 專用權杖，伺服器據此判定身分；`X-Team-Actor` 不再有效）。leader 不能 approve、reject、回答待決事項、改派
（伺服器與 engine 都拒絕），重試有預算且不重置 attempts；系統提示升為 v2（新對話）說明這些限制。leader 的 claude
本身不在 OS 沙箱內（它的 `team` 要讀 DATA 下的 listener 檔並連本機埠）：它若跑到清單外的指令，讀得到的不只空目錄，
也包括 operator 權杖（剩餘風險，見 ADR 0014）。
