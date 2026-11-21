# 0012 leader 的 shell 範圍

狀態：採用（整合收尾；補充 spec §9；安全審查修正見最後一節）

**問題**：leader 只有 Bash 一個工具，`--allowedTools` 只放行 `team`，`--permission-mode dontAsk` 拒絕其他指令。
但 Claude Code 會自動核准它內建的唯讀指令（`echo`、`pwd`、限於工作目錄的 `ls`），不經 allow-list。

**決定**（`apps/server/src/leader/args.ts`）：

- allow：只列 leader 用得到的 `team` 子指令——裸指令用精確規則（`Bash(team status)`、`Bash(team doctor)`…），
  帶參數的用前綴規則（`Bash(team task:*)`、`Bash(team attention:*)`、`Bash(team receipt:*)`、`Bash(team --json:*)`…）。
  `serve`、`watch`、`ask`、`leader`、`project` 不在其中（shim 與伺服器另外也會拒絕）。
- deny（`--disallowedTools`，必要旗標，見最後一節）：約 70 個常見的唯讀、輸出、環境、shell 與直譯器指令，
  每個都有裸指令與 `:*` 兩條規則（`ls`、`cat`、`head`、`grep`、`find`、`echo`、`printf`、`pwd`、`env`、`printenv`、
  `git`、`node`、`python3`、`sh`…）。deny 優先於 allow 與自動核准；有單元測試確認沒有任何 deny 規則能匹配
  `team …`（含 heredoc 形式）。
- 其餘維持：`--tools Bash`、`--safe-mode`、`--strict-mcp-config`、空的 `--mcp-config`、`--restricted`、
  `--permission-prompts none`（第二輪起 `--safe-mode`、`--restricted`、`--disallowedTools`、`--permission-prompts`、
  `--settings` 都是必要旗標）；工作目錄是 `DATA/leader/cwd`（空目錄）；子行程環境只有 allow-list 的變數
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
也包括 operator 權杖（剩餘風險，見 ADR 0014）——第二輪已改，見下節。

**第二輪審查修正（fail closed、沙箱、重放）**：

- 必要旗標：`--restricted`、`--safe-mode`、`--disallowedTools`、`--permission-prompts`、`--settings` 任何一個 probe 找不到，
  leader 就是 `not_installed` 並寫出缺哪個旗標，不再「有列才傳」。
- leader 的 Bash 在 Claude Code 的沙箱內（`apps/server/src/leader/sandbox.ts`，與 claude worker 同一個機制）：
  `denyRead` 家目錄、DATA、憑證目錄與 `.env`；`allowRead` 只有 `DATA/leader/{bin,cwd,listener.json,turn-key,api.sock}`
  與這個 checkout 的 `apps`、`packages`、`node_modules`、`package.json`；`denyWrite` 同一份拒絕清單；網路
  `allowedDomains: []`（strict）、`allowLocalBinding: false`、只開一個 `allowUnixSockets: [DATA/leader/api.sock]`；
  `autoAllowBashIfSandboxed: false`（allow／deny 清單照舊）。為了不開 loopback：Claude Code 2.1.326 的設定檔產生器
  （從執行檔讀出）只有 `allowLocalBinding` 一種 loopback 開關，產生 `network-outbound (remote ip "localhost:*")`——任何
  本機埠都通；unix socket 才能限定路徑（`network-outbound (remote unix-socket (subpath …))`）。所以服務另外在
  `DATA/leader/api.sock`（0600，0700 目錄，同一個本機 app）提供 API，leader 的 listener 檔帶 `socket`，CLI 經它連線
  （`unixSocketFetch`），shim 另外清掉 proxy 變數。socket 路徑超過 103 位元組 → leader 不可用。產生器也確認：
  `allowRead` 內的 deny（例如 `~/.cache` 底下的 DATA）在 allow 之後重新套用，較深的規則優先。
- 驗證：離線（不呼叫模型）以照產生器寫的 Seatbelt 設定檔跑正式的 shim：`team status`、`team task list` 經 socket 成功，
  `cat DATA/run/listener.json` → Operation not permitted，TCP 連不上。真實 haiku turn（2026-11-21，$0.0024，6.9 s）：
  `team status` 與 heredoc 形式的 `team task add`（草稿）都成功，Claude Code 自己的對話紀錄把兩個指令都記為
  `"sandboxed": true, "sandboxViolations": []`；`/bin/cat DATA/run/listener.json`（絕對路徑形式）被權限層拒絕。
  沒有觀察到的：在真實 turn 裡由沙箱（而不是權限層）擋下的讀取——allow 清單只放行 `team`，執行期的行程檢查又沒抓到
  那幾百毫秒的 `team` 行程，之後再多一個真實 turn 不在本輪的模型呼叫額度內。
- 重放（`leader/replay.ts`）：每則輸入在 spawn 前於 kv 記 `leader:turn_started:<msg|events>`，回覆存好或確定失敗才
  清除（turn 沒執行任何指令就失敗也清除）；仍有標記的輸入再跑時提示最前面加「可能已經做過，建立前先 `team task
  list` 確認」。turn 期間服務寫 `DATA/leader/turn-key`（`leader:msg:<id>`／`leader:events:<seq>`），shim 讀它設
  `AGENT_TEAM_IDEMPOTENCY_SEED`，`team task add` 以「種子 + 請求內容的 sha256」當 Idempotency-Key：完全相同的建立
  請求在重放時由伺服器回原結果。真實 turn 的 `team task add` 帶的鍵是 `leader:msg:m_…:<hash>`。
- 剩下的：leader 的 claude 行程本身不在沙箱內（沙箱套在它執行的 Bash 上），它讀得到 DATA；這與「同使用者、不在
  沙箱內的行程」同一類剩餘風險。Linux 上 Claude Code 不支援以路徑限定 unix socket（seccomp），leader 的 `team` 在
  Linux 沙箱內連不到服務（未在本機驗證）。內容稍有不同的重複建立不會被去重。
