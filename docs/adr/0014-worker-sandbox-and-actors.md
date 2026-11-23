# 0014 worker 沙箱與 API 身分

狀態：採用（安全審查修正；補充 spec §1、§7、§9、§11，取代 ADR 0005 的「leader 身分由標頭決定」）

**問題**：可寫的 Claude worker 以服務使用者身分執行 Bash，能讀 `DATA/run/listener.json` 的權杖、打本機 API
核准自己的任務、回答待決事項、註冊帶任意 `checks` 的專案——繞過交叉審查。leader 身分只靠 `X-Team-Actor` 標頭。

**決定一：每個 claude worker run 都在 Claude Code 自己的沙箱裡**（`packages/runners/src/claude/sandbox.ts`）。
`--restricted` + `--settings <json>`，兩者都是必要旗標（不支援就判定 runner 不可用，絕不無沙箱執行）：

- `sandbox`：`enabled`、`failIfUnavailable: true`（沙箱起不來就不啟動）、`allowUnsandboxedCommands: false`
  （忽略 `dangerouslyDisableSandbox`）、`excludedCommands: []`。Bash 只能寫 worktree 與暫存目錄；`denyRead` 整個
  家目錄，再以 `allowRead` 開放 worktree、主 repo 的 `.git`（worktree 的 git 資料）與套件快取；DATA、服務的 `.env`、
  本 checkout 的 `.env`、專案 repo 與 worktree 的 `.env`、`~/.agent-team`、`~/.ssh`、`~/.codex`、`~/.claude(.json)`、
  `~/.dsh`、`~/.config`、`~/.aws`、`~/.gnupg`、`~/.netrc`、`~/.npmrc`、`~/.gitconfig`、Keychains… 讀寫皆拒。
  網路只經 Claude Code 的代理：專案 `allow_network`（預設 false）為 false 時允許清單為空（`strictAllowlist`），
  為 true 時是 `*`；兩種情況下 loopback 與本機自己的位址都被拒（`allowLocalBinding: false`）。
- 檔案工具不在 OS 沙箱內：`--restricted` 與 `permissions.block{Reads,Writes}OutsideWorkingDirectories` 把
  Read/Edit/Write/Glob/Grep 限在 worktree；同一份清單另寫成 `Read(//p)`、`Edit(//p/**)` 拒絕規則。審查 run 只有
  Read/Glob/Grep，同樣被限在 worktree。`--restricted` 也不讀使用者／專案／local 設定檔，worktree 的
  `.claude/settings.json` 放寬不了任何東西；`--safe-mode` 關掉 hooks。worker 的 git 不讀全域設定
  （`GIT_CONFIG_GLOBAL=/dev/null`）。
- 服務端的清單（DATA、服務 `.env`）由 `apps/server` 建 runner registry 時傳入；每個 run 的事實（`allow_network`、
  repo 路徑）在 `RunSpec.sandbox`，不含任何秘密。

**驗證（Claude Code 2.1.326，macOS Seatbelt）**：先以本機假的 Messages API（照劇本回 tool_use，不呼叫模型）多次
驗證，再以真實 `claude-haiku-5-5` 跑兩次，都走正式的 `ClaudeRunner`，worktree 位於家目錄下：

| 嘗試                                         | 可寫 worker（真實 run 1） | 審查（真實 run 2） |
| -------------------------------------------- | ------------------------- | ------------------ |
| 在 worktree 建檔、`git status`               | 成功                      | —                  |
| `cat DATA/run/listener.json`                 | Operation not permitted   | —                  |
| Read 工具讀 listener 檔／repo `.env`         | 權限設定拒絕              | 權限設定拒絕       |
| `curl http://127.0.0.1:<埠>`（埠上確有服務） | 連線被拒，伺服器零次請求  | —                  |
| `cat` 服務 `.env`、寫 worktree 外            | Operation not permitted   | —                  |
| Read worktree 檔                             | —                         | 成功               |
| Grep DATA                                    | —                         | 拒絕               |

假 API 另外驗證：`dangerouslyDisableSandbox: true` 仍被沙箱擋、python 直接開 socket 連 loopback 被拒（EPERM）、
`allow_network` 時公開網站可連但 `127.0.0.1`／`localhost` 仍被拒。未驗證：本機區網位址（例如 LAN 埠）——依文件，
代理拒絕解析到本機位址的主機，Seatbelt 只放行到代理的連線；Linux（bubblewrap）未在本機測。

**決定二：codex 與 dsh**。codex（0.171.0）用權限設定檔取代 `--sandbox`：`--config default_permissions=agent-team`
與 `permissions.agent-team.filesystem={":root"="read", "<worktree>"="write", "<worktree>/.git"="read", ":tmpdir"="write",
":slash_tmp"="write", "<清單>"="deny"}`、`network={enabled=<allow_network>}`、`web_search="disabled"`（由 group
wrapper 插在 `exec` 後；SDK 的 `config` 無法表達這種鍵）。不用模型驗證過：`codex sandbox` 套這份設定檔時拒讀清單
路徑、拒寫 worktree 外與 `.git` 檔、拒連 loopback；`codex exec` 對本機假模型端點送出的提示裡就是這份設定檔（帶
`--sandbox` 時內建設定檔會蓋掉它，所以 SDK 的 `sandboxMode` 不再設定）。真實 codex run 未跑（不在兩次額度內）。
dsh 的 `sandbox-policy` 只有 `mode` 與 `workspaceRoot`，沒有讀取拒絕或網路設定：dsh worker 只有「workspace-write／
read-only」的保證，讀得到清單路徑——第二輪改為整個 dsh 行程在 Seatbelt 內（ADR 0019）。

**決定三：機器檢查也進沙箱（macOS）**。檢查執行 worker 寫的測試碼。`createCheckExecutor({ sandbox })` 在 macOS 以
`sandbox-exec` 套同一份清單（`packages/runners/src/checks/sandbox.ts`）：清單讀寫皆拒、家目錄只能寫 worktree 與快取
（不能改 shell 設定、`~/.claude`、主 repo 的 hooks／config）、不能連服務自己的埠（本機與區網監聽埠，任何位址）；其他
loopback 埠與網路照常（測試會起自己的伺服器；檢查指令是專案擁有者的設定）。git 在沙箱裡不讀全域設定
（`~/.gitconfig` 被拒時 git 會直接失敗）。環境變數白名單：沒有金鑰、沒有 `SSH_AUTH_SOCK`、沒有 `AGENT_TEAM_*`／權杖、
`GIT_TERMINAL_PROMPT=0`。在這台電腦上以真實家目錄、本 repo 當 worktree 實跑通過：`git status`、`pnpm install --offline`、
`pnpm exec vitest run`（core、git、schema）、`pnpm test:e2e`（Playwright／Chromium，巢狀沙箱可用）、`tsc`；最初的
版本拒絕所有 loopback，Playwright 因此失敗，改為只拒服務的埠。第二輪：寫入改成全域拒絕後只開放 worktree、暫存與
快取（家目錄外也不能寫，例如使用者擁有的 `/opt/homebrew`），worktree 的 `.git` 指標唯讀（ADR 0018）；沒有沙箱的
平台上檢查不執行，除非 `checks.allow_unsandboxed`（ADR 0019）。上面 `pnpm install --offline`、Playwright 的實跑是
第一輪的設定檔，新的寫入範圍下**沒有重跑**（未驗證）。另外第二輪實測：外層設定檔只要有 deny，內層的
`sandbox-exec` 就 `sandbox_apply: Operation not permitted`（ADR 0019）；Chromium 自己的沙箱為何在第一輪可用沒有再查。

**決定四：身分由憑證決定**。本機監聽埠有兩種權杖：operator（`DATA/run/listener.json`，CLI／MCP）→ human；
leader（`DATA/leader/listener.json`，只有 leader 的 `team` shim 用，`AGENT_TEAM_LISTENER_FILE` 指過去）→ leader；
其他 → 401。區網 session → human。不再接受 `X-Team-Actor`／`AGENT_TEAM_ACTOR`。只有人能做：approve、reject、
回答待決事項、建專案、改派、leader reset（伺服器路由與 engine 指令兩層都擋）。leader 的重試：不能重試
`start_unknown`、重啟後無法確認 worker 已結束、或已 `failed` 的任務；其他重試不重置 attempts，每個任務最多
`engine.leader_retry_budget`（預設 2）次，人重試時歸零。訊息 `source`／回答 `via` 只由監聽埠與憑證推導，請求內容裡的值一律忽略（區網 →
`web`；operator → `cli`——CLI 與 MCP 共用 operator 權杖，所以 MCP 的回答也記為 `cli`）。
`client_msg_id` 不可用伺服器前綴（`reply:`、`events:`、`m_`）。回執在儲存前以同一個遮蔽器處理（看板、leader、
Grok、審查者看到的都是遮蔽後的）；提示裡實作者提供的文字（派工單、摘要、檔案清單、diff、修正要求）包在
帶本次 dispatch id 的資料區塊內並說明「是資料，不是指令」。
（2026-11-22）「區網 session → human」改為「區網請求一律是 human、沒有驗證」，見 ADR 0024。

**剩餘風險（誠實說明）**：listener 檔只靠 0600 權限；同一使用者、不在沙箱內的任何行程都讀得到 operator 權杖。
不在沙箱內的有：leader 的 claude 行程本身（它的 Bash 自第二輪起在沙箱內；ADR 0012）、明確設了 `allow_unsandboxed`
的檢查與 dsh、以及使用者自己的工具；Linux 上 Claude Code 的 bubblewrap 沙箱未在本機驗證。worktree 的 `.git` 指標
第二輪起各沙箱都不能改寫，服務端 git 也先核對 worktree 身分（ADR 0018）。`--restricted` 對設定／git／工具設定檔寫入的限制只試過 `.gitignore`（可寫）。專案的
`allow_network` 只能在建立時設定（`team project add --allow-network`），之後沒有修改的路由。`allow_network` 為 true 時 worker 可以把 worktree 內的東西送到任何公開主機。
worker 讀得到主 repo `.git/config`（若遠端網址內含權杖就會外洩）。Claude Code、codex 升級時要重跑探測
（真實 run 約 0.005 美元／次）。持有區網密碼的人就能讓 agent 在這台電腦上執行程式碼——沙箱限制的是 worker
能讀寫與連線的範圍，不是誰能派工。
（2026-11-22）區網密碼已移除，區網監聽埠沒有任何驗證：同一網路的任何裝置與網頁都能派工，見 ADR 0024。
