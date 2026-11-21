# 0019 dsh 進 Seatbelt；沒有沙箱時檢查與 dsh 一律不執行

狀態：採用（第二輪安全審查；補充 spec §6 步驟 4、§7 dsh，取代 ADR 0014「dsh 只有 workspace-write」與
「Linux 上檢查不在沙箱內」兩項剩餘風險）

**問題**：dsh 自己的 `sandbox-policy` 只有 workspace-write／read-only，讀取不受限：dsh worker 讀得到 DATA（含 operator
權杖的 listener 檔）、`.env` 與憑證目錄。機器檢查在沒有 `sandbox-exec` 的平台上直接在沙箱外執行 worker 寫的程式。

**決定一：整個 dsh 行程在 macOS Seatbelt 內**（`packages/runners/src/dsh/sandbox.ts`，與機器檢查同一個
`sandbox-exec` 包裝）：

- 讀：家目錄關閉，再開放 worktree、主 repo 的 `.git`、套件快取／工具鏈、`~/.dsh`（執行期：profiles、presets、cache；
  `.credentials.yaml`、`.env`、`sessions`、`storages`、`attachments`、`llm-deepseek` 拒絕）、`~/.agents`；目錄的
  metadata 可讀（realpath）。DATA、服務與 repo 的 `.env`、`~/.ssh`、`~/.codex`… 拒讀拒寫，只有 run 自己的
  `DATA/runs/<id>/dsh-state/`（patch 把 `session-persistence-jsonl`、`storage-json` 的根導到這裡）與 patch 檔例外。
- 寫：`(deny file-write* (subpath "/"))` 之後只開放 `/dev`、暫存目錄、run 的 state 目錄，可寫 run 加上 worktree
  （`.git` 指標除外，ADR 0018）；唯讀 run 連自己的 cwd 都不能寫。也擋家目錄外的寫入（使用者擁有的 `/opt/homebrew`
  原本可寫，可以換掉服務自己執行的 `node`）——機器檢查的設定檔一併改成同樣的寫入範圍。dsh 每次啟動會改寫
  `~/.dsh/profiles/headless/cordis.yml`（空白根設定，dsh 先重設再載入），只開放這一個檔。
- 網路：Seatbelt 的 `remote ip` 只能寫 `localhost` 或 `*`，無法限定 OpenRouter；所以對外照常，服務自己的埠
  （本機與區網監聽埠）在任何位址都拒絕。
- dsh 自己的 bash 沙箱無法巢狀：外層設定檔只要有任何 deny，內層 `sandbox-exec` 就 `sandbox_apply: Operation not
  permitted`（實測，`dsh-sandbox.test.ts` 釘住）。第一次真實 run 因此所有 bash 都失敗（模型只用檔案工具改完）。在
  外層沙箱內 patch 改設 `danger-full-access`：dsh 不再自己限制，限制全由外層設定檔負責（它比 dsh 的 workspace-write
  更嚴：讀取也受限）。
- git：dsh 的子行程層會丟掉名稱含 `KEY|PASSWORD|SECRET|TOKEN` 的變數，`GIT_CONFIG_KEY_0` 被丟掉而 `GIT_CONFIG_COUNT`
  留下，git 直接失敗（真實 run 實測）；dsh 改用 `GIT_CONFIG_GLOBAL=/dev/null` 與 run 內空的 `XDG_CONFIG_HOME`。
- 沒有 `sandbox-exec`（Linux）：dsh runner 不可用（fail closed；寫入與唯讀 run 都是，hub 的整理就改用角色 fallback），
  除非 `service.json` 的 `runners.dsh.allow_unsandboxed: true`，此時回到 dsh 自己的 workspace-write／read-only。

**決定二：機器檢查不在沙箱外執行**（`checks/executor.ts`）。沒有沙箱 → 不執行，結果 `refused`：run 拒收
（`checks_unsandboxed`）、任務阻塞並說明原因，不開修正輪（不是 worker 的錯）；`checks.allow_unsandboxed: true` 才在
沙箱外執行（日誌標 `UNSANDBOXED`）。Linux 使用者在 bubblewrap 支援之前必須明確選擇。

**驗證**：`dsh-sandbox.test.ts`（DATA、憑證、`.zshrc`、`.git` 拒絕，dsh 需要的可讀可寫；巢狀拒絕；git 在設定檔內可用；
沒有沙箱時不可用、不 spawn）；`checks.test.ts`、`integrity.test.ts`（拒絕執行 → 阻塞、沒有修正輪）。真實 dsh
0.2.1-rc.5（deepseek-flash）兩次 run：

- 第一次（直接走 runner，15.9 s 完成）：`sandbox_check()` 查執行中的 dsh 行程——listener 檔、`~/.ssh` 拒讀，worktree
  的 `.git` 與 `/opt/homebrew/bin/node` 拒寫，worktree 可讀寫；以同一份設定檔重放：`cat` listener 檔與
  `~/.dsh/.credentials.yaml` → Operation not permitted，`curl` 服務埠 → 連不上。巢狀問題就在這次發現。
- 第二次（修正後的端到端，10 s）：執行中的行程——listener 檔、`team.db`、`~/.ssh`、`~/.dsh/.credentials.yaml` 拒讀，
  `/opt/homebrew/bin/node` 拒寫；dsh 在沙箱內跑了 `ls`、`cat`、`node --test`（通過）。git 問題在這次發現，修正
  （`GIT_CONFIG_GLOBAL` + 空的 `XDG_CONFIG_HOME`）只以離線測試驗證（真實 git、同一份設定檔），沒有再用真實模型跑；
  修正後的設定檔、patch 與環境離線開機到 `MISSING_CREDENTIAL`（不呼叫模型）。

**後果**：Linux 上 dsh 與機器檢查預設不能用。dsh 在沙箱內沒有網域白名單；它讀得到自己的 profiles 與 `~/.agents`。
dsh 或 macOS 升級時重跑 `dsh-sandbox.test.ts` 與一次真實 run。
