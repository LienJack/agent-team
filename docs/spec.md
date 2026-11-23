# agent-team 規格 v2

本機多 agent 開發服務。一支 Node 服務持有全部狀態（SQLite）與一個無頭的 Team Leader 對話；worker 是一次性的
無頭行程（Claude／Codex／dsh）；人從看板（區網可用）、CLI、MCP（桌面端）或手機 Grok 進來。

這份文件是實作的唯一依據。沒寫到的，選最簡單的做法並在回報裡列出。設計依據見第 15 節。

## 1. 原則

1. **回執制**：任何模型都不讀另一個 worker 的對話過程。worker 只交一份結構化回執，服務端核對後才算數。
2. **服務端不信任 agent**：完成與否由服務端對照 git 實際變更與機器檢查決定；worker 不 commit，服務端代做。
3. **先落庫再執行**：每個有副作用的動作（啟動行程、提交、對外發訊息）先寫成一筆 effect，與狀態變更同一個交易，
   成功才刪除。服務重啟後未刪除的就是未完成的。
4. **派工編號是柵欄**：只有帶著當前 `dispatch_id` 的結果有權改變任務狀態。結果不明時絕不自動重送。
5. **核心不碰 IO**：領域邏輯只依賴介面（ports），有一套純記憶體實作供測試。
6. **合約先行**：資料結構與 API 只定義一次（Zod），服務端、CLI、MCP、網頁共用同一份型別與同一個客戶端。
7. **薄入口**：CLI、MCP、網頁、Grok 橋接都只是 API 的包裝，不放業務邏輯。
8. 憑證不進版控、不進資料庫、不進日誌、不進任何 API 回應，**也不進任何子行程的環境**（同一使用者的行程讀得到別的
   行程的環境）：dsh 拿到的是只在該 run 期間有效的權杖，真正的金鑰留在服務端的金鑰代理（ADR 0020）。
9. **worker 在沙箱裡**：讀寫只限 worktree（與暫存、套件快取），DATA、`.env`、憑證目錄一律拒絕，worktree 的 `.git`
   指標檔不可改寫，連不到本機的服務埠；dsh 與機器檢查另外不能對沙箱外的行程送訊號、不能連家目錄／DATA／ssh-agent／
   Docker 的 unix socket；沙箱起不來就不執行（fail closed）：claude、codex、dsh、機器檢查、leader 的 Bash
   都一樣（ADR 0014、0018、0019、0020、0012）。身分由憑證決定，不由請求內容決定（ADR 0014）。

## 2. 技術棧

| 項目 | 選擇 |
|---|---|
| 執行環境 | Node ≥ 26、pnpm workspaces；開發用 `tsx`，正式用 `tsc -b` 產出後以 `node` 執行 |
| 語言 | TypeScript strict（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`），專案參照 |
| 結構與驗證 | Zod（領域物件、回執、事件、API 請求與回應、設定檔） |
| 服務框架 | Hono + `@hono/node-server` + `@hono/zod-openapi`；產出 `openapi.json` 並提交，CI 檢查是否漂移 |
| 型別安全的客戶端 | 路由合約（`createRoute`，不含處理函式）放 `packages/protocol`；由它產生 `openapi.json`；`packages/client` 用 `openapi-typescript` 產生的型別 + `openapi-fetch`。產生檔提交進版控，CI 檢查漂移 |
| 資料庫 | SQLite + Drizzle ORM；`drizzle-kit` 產生帶時間戳的 SQL 遷移，啟動時套用；WAL、`busy_timeout=5000` |
| 前端 | React + Vite + Tailwind + TanStack Query + zustand；拖放用 `@hello-pangea/dnd` |
| MCP | `@modelcontextprotocol/sdk`（stdio） |
| CLI | commander |
| Codex | `@openai/codex-sdk`，鎖定確切版本，使用它自帶的執行檔 |
| 測試 | vitest（單元、整合；看板元件測試用 jsdom，根目錄 `pnpm test` 一併執行）；Playwright 一條看板冒煙（`pnpm test:e2e`，有 Playwright 的 Chromium 就用它，否則用系統的 Chrome） |
| 品質 | oxlint、oxfmt、`tsc -b`。git hook 不自動安裝（husky 會改寫各 worktree 共用的 git 設定）；需要時手動 `pnpm hooks:install` |
| CI | GitHub Actions：安裝 → lint → typecheck → test → build（含 `vite build`）→ 邊界檢查 → 產生檔漂移；Playwright 冒煙是另一個 job |

SQLite 驅動：Node 內建的 `node:sqlite`（免原生編譯）。drizzle-orm 0.45 沒有它的驅動，所以自寫一個同步的 Drizzle
session；遷移由 drizzle-kit 產生、自寫的 migrator 套用（ADR 0007）。
所有依賴鎖定確切版本。不在執行期用 `npx -y` 下載任何東西。

## 3. 工作區

```
packages/schema     Zod：領域物件、狀態與轉換表、回執、事件、API DTO、設定檔。無其他依賴
packages/protocol   API 路由合約（@hono/zod-openapi 的 createRoute）與 openapi.json 產生腳本。只依賴 schema
packages/core       領域邏輯：ports、engine（排程、核對、升級、復原）、記憶體版 repositories。只依賴 schema
packages/db         Drizzle schema、遷移、SQLite 版 repositories（實作 core 的 ports）
packages/runners    Runner 實作：claude、codex、dsh、fake；共用的子行程工具；錄製的 fixture
packages/git        worktree 生命週期、變更清單、代 commit、基底漂移檢查（實作 core 的 ports）
packages/client     型別安全的 HTTP 客戶端 + 讀取 listener 檔的連線工具 + `askLeader`（等 leader 回覆）。只依賴 schema、protocol
apps/server         Hono 應用、驗證與區網監聽、SSE、組裝（wiring）、leader、hub
apps/cli            `team` 指令
apps/mcp            stdio MCP 伺服器
apps/web            看板與聊天
config/             models.json（已存在）、service.json
docs/               spec.md、adr/、conventions.md
```

依賴方向只能往上表的上方走；`apps/*` 之間互不依賴。用一支檢查腳本在 CI 裡擋住違反的 import（允許表比這更嚴，
見 ADR 0006：`db`／`runners`／`git` 互不依賴，`cli`／`mcp`／`web` 只依賴 `schema` 與 `client`）。
單一原始檔不超過 500 行；超過就拆。每個套件有自己的 `README.md`（三五行說明職責與對外介面）。
根目錄 `AGENTS.md` 寫給 agent 看的開發規範（`CLAUDE.md` 連到它）。重要決定寫 `docs/adr/NNNN-title.md`（半頁以內）。

## 4. 路徑

| 用途 | 位置 |
|---|---|
| 資料目錄 `DATA` | `~/.agent-team/`（`AGENT_TEAM_HOME` 可覆寫；測試一律覆寫到暫存目錄） |
| 資料庫 | `DATA/team.db` |
| 連線資訊 | `DATA/run/listener.json`（權限 0600）：`{ addr, token }`，operator 權杖，供 CLI／MCP 自動連線；`DATA/leader/listener.json`（0600）：`{ addr, token, socket }`，leader 專用權杖與 unix socket `DATA/leader/api.sock`（0600，同一個本機 app），只給 leader 的 `team` shim（`AGENT_TEAM_LISTENER_FILE`）。DATA 啟動時設為 0700 |
| 執行日誌 | `DATA/runs/<run_id>/{events.jsonl, stderr.log, prompt.md}` |
| leader | `DATA/leader/cwd/`（空的工作目錄）、`DATA/leader/bin/team`（以 leader 身分執行的 shim）、`DATA/leader/turn-key`（目前 turn 的冪等種子）、`DATA/leader/turn/`（最近一個 turn 的日誌） |
| 任務 worktree | `<worktree_root>/<project>/<task_id>/`，預設 `~/RanoLabs/worktrees`，分支 `team/<task_id>` |
| 金鑰 | 專案根目錄 `.env`（git 忽略；`AGENT_TEAM_ENV_FILE` 可改指）。`packages/schema` 定義需要哪些變數，`apps/server` 提供唯一的讀取函式，一次只回傳被要求的那一個。秘密只放 `.env`：出現在服務自己的行程環境裡時，啟動時對每個變數記一條警告（只寫名稱；ADR 0020） |

## 5. 領域模型

id 用前綴 + 隨機短字串（`p_`、`t_`、`w_`、`r_`、`a_`、`m_`）。時間一律 ISO 8601 UTC。

```
project      id, name, repo_path, base_branch, checks[{name, cmd}], allow_network(預設 false)
task         id, project_id, parent_id?, title, tier(A|B|C), ticket_md, owned_paths[], priority,
             status, impl_role, fix_rounds, leader_retries, attempts, blocked_reason?, version
workspace    id, task_id, path, branch, base_sha, head_sha?, accepted_base_sha?, state(active|kept|removed)
             -- active＝服務端管理中（任務完成後仍是 active，直到定時清理移除）；kept＝移除時發現未提交的變更，
             --   刻意保留、不再自動清理、開一筆待決事項給人；removed＝已移除（ADR 0009）
run          id, task_id, workspace_id, dispatch_id(unique), kind(impl|fix|review), role, model_alias, runner, model,
             state(starting|running|succeeded|failed|start_unknown|stopped|abandoned),
             outcome?(ok|rejected|error|rate_limited|timeout|cancelled), reject_reason?,
             session_ref?, receipt?, usage?, cost_usd?, cost_estimated, log_dir, pid?, pid_started_at?,
             launched_at?, started_at, ended_at?
             -- cost_estimated：runner 沒回報費用（codex、dsh）時 cost_usd 是 token 用量 × models.json 牌價的估算
             --   （未快取輸入與 cache 寫入用輸入價、cache 讀取用輸入價的 10%、輸出用輸出價），每個顯示處都標「估算」
attention    id, task_id?, kind(decision|approval|question), topic, question, options[],
             status(open|answered|superseded), answer?, answered_via?
             -- topic：開事項的地方設定（general|worker_question|runner_halted|base_drift|start_unknown|
             --   worker_unconfirmed|worktree_identity|workspace_kept|unclassified）；風險是 schema 裡的一張表，
             --   base_drift 起的六種是 high：只能在看板或 CLI 回答（§10，ADR 0022）
message      id, channel(leader|grok), direction(in|out), source(web|cli|mcp|grok|service), body,
             client_msg_id(unique per channel), ref?, status(new|delivered|acked), seq
event        seq(autoincrement), ts, type, task_id?, run_id?, data           -- 持久變更紀錄，SSE 的游標
effect       kind, key, payload, seq, generation, attempts, due, error?      -- PK(kind, key)
outbox       id, target(grok), kind, body, signature(unique), status(pending|sent|failed), task_id?, attempts
idempotency  caller, request_id, method, payload_hash, state(pending|completed), response   -- PK(caller, request_id)
kv           key, value
```

`task.status`：`draft → queued → running → verifying → review → done`，旁支 `blocked`、`failed`、`cancelled`。
合法轉換是 `packages/schema` 裡的一張表；狀態只由 engine 改，用 `version` 做比較後才設定（樂觀鎖）。每個指令先檢查
來源狀態：`queue` 只接受 `draft`，`retry` 只接受 `blocked`／`failed`，approve／reject 只接受 `review`；不符回 409。

`owned_paths`：repo 相對 POSIX 路徑或 glob；`.`、`./` 是整個 repo；拒絕 `..`、絕對路徑、空段（`a//b`）、反斜線。
專案的檔案系統不分大小寫時（`core.ignorecase`）比對也不分大小寫；核對變更時先解析 symlink。
看板五欄：待派 = draft、queued；進行中 = running、verifying；待驗收 = review；阻塞 = blocked、failed；完成 = done。

`idempotency`：所有會改變狀態的 API 接受 `Idempotency-Key`。同鍵同內容回傳原結果；同鍵不同內容回 409。
CLI、MCP、Grok 橋接一律帶上。

## 6. 回執

worker 最後的回答必須是符合 schema 的 JSON，三家都用各自的結構化輸出功能強制。

```
ImplReceipt    { dispatch_id, status(done|blocked|failed), summary(≤600字), files_changed[],
                 checks[{cmd, result(pass|fail|not_run), note}], needs_leader }
ReviewReceipt  { dispatch_id, verdict(pass|needs_changes|blocked), summary(≤600字),
                 findings[{file, line, severity(must_fix|should_fix|note), issue}] }
```

核對（`core` 的 verify，逐步，任何一步不過就 `outcome=rejected` 並記 `reject_reason`）：

1. 回執通過 Zod（先正規化格式失誤：`summary` 截到 600 字、缺漏的 `needs_leader`／清單補空值；ADR 0017）；`dispatch_id`
   等於該 run 的編號且該 run 仍是任務的當前 run。回執的每個字串先以日誌的遮蔽器處理再儲存。
2. `blocked`／`failed` → 任務進 `blocked`；`needs_leader` 非空則開一筆 attention。人回答該任務最後一筆未回答的項目後，
   因 worker 回報而阻塞的任務自動重新排入；之後每個 run 的提示都附上問與答（ADR 0017）。
3. worktree 確有變更（修正 run 已有服務端提交時可以不再修改：照常檢查、不新增提交、回到審查；ADR 0017）；實際變更檔案
   全部落在 `owned_paths` 內（以 git 為準，不以回執自述為準；symlink 解析後再比）。
4. 專案的機器檢查全過（逐條執行，完整輸出存日誌，只把結果與最後 20 行留給修正單）。檢查執行 worker 寫的程式：
   環境白名單（無金鑰、無 `SSH_AUTH_SOCK`、無權杖），以 `sandbox-exec` 套 worker 的拒絕清單（ADR 0014）：訊號只能送給
   沙箱內的行程，家目錄（worktree 除外）、DATA、ssh-agent、Docker 與 tmux 的 unix socket 連不到，服務的埠與金鑰代理的
   埠都連不到（ADR 0019 第三輪、0020）。沒有沙箱
   （Linux）就不執行：任務阻塞並說明原因，不開修正輪；`service.json` 的 `checks.allow_unsandboxed: true` 才在沙箱外
   執行（ADR 0019）。
5. 提交前重算變更清單：檢查後多出任何檔案或出現越界 → 拒收、不提交。服務端只提交核對過的檔案
   （`git add -- <檔案>`、`team(<task_id>): <title>`），不執行 repo 的 hooks（ADR 0016），記 `head_sha`。服務端在
   worktree 裡的**每一個** git 指令之前（派工、核對、提交、審查 diff、漂移、清理）都核對 worktree 身分：`.git` 是一般
   檔案、`--git-dir` 是 `<repo>/.git/worktrees/<name>` 且其 `gitdir` 指回這個 worktree、`--git-common-dir` 是主 repo 的、
   HEAD 在 `team/<task_id>`；`git commit` 前再核對一次，且絕不在基底分支上提交。不符 → run 拒收、不提交、任務阻塞並開
   待決事項，只有人能重試（ADR 0018）。
6. 任務進 `review`，排入審查 run（`review_A|B|C`）。審查者的模型別名不得與最近一次實作 run 相同。

審查 `pass` → `done`。`needs_changes` → 修正 run（帶 must_fix 清單），`fix_rounds+1`；達到
`rules.max_fix_rounds_before_escalate` 後換 `escalate_to` 的角色；無處可升則 `blocked`，並開一筆待決事項
（`topic=fix_limit`）問人；回答會交給下一個 worker，任務重排並重新給修正額度，人按重試也重新給額度（ADR 0025）。

## 7. Runner

```ts
type RunSpec = { dispatchId; cwd; prompt; schema: JsonSchema; model; effort?; writable: boolean;
                 logDir; timeoutMs; env?: Record<string,string>; resumeRef?: string };
type RunResult = { final?: unknown; usage?; costUsd?; sessionRef?;
                   error?: { kind: 'rate_limit'|'auth'|'timeout'|'crash'|'bad_output'|'start_unknown'; message };
                   quota?: { utilization?; resetsAt?; exhausted? } };
interface Runner { readonly name; probe(): Promise<RunnerCapabilities>; run(spec, signal): Promise<RunResult>; }
```

選用能力以小介面另外宣告（`Resumable`、`QuotaReporting`）。`probe()` 在服務啟動與 `team doctor` 時執行：
確認執行檔存在、版本、支援的參數、憑證是否就緒（不顯示值）；不支援的參數不要傳。

共同要求：參數一律用陣列，不經 shell；標準輸入明確關閉或寫入後關閉；子行程自成行程群組，逾時或取消時終止整個群組，
連同送訊號前快照到的、離開群組的後代（`setsid` 的子行程；子先於父，SIGKILL 前以 pid＋啟動時間再核對）；worker run 與
機器檢查結束時，再終止有擁有權證明的遺留行程（父行程是 init、同使用者、無終端、run 期間啟動、工作目錄或命令列含該 run 的
worktree／調研目錄／日誌目錄；ADR 0022）；
傳給子行程的 `HTTP(S)_PROXY`／`ALL_PROXY` 去掉 `user:pass@`；run 日誌目錄 0700、檔案 0600（已存在的也收緊）；
spawn 前呼叫 `onLaunching`、spawn 後以 `onSpawned` 回報 pid 與 OS 啟動時間（ADR 0015）；輸出逐行讀取，單行上限 1 MiB
（超過截斷並標記，繼續讀下一行）；
完成判定是「agent 的結束訊號」與「行程結束」先到者為準；原始事件流寫 `events.jsonl`；日誌寫入前遮蔽看起來像金鑰的字串。

- **claude**：`claude -p --model … --output-format stream-json --verbose --json-schema … --safe-mode --restricted
  --settings <沙箱設定> --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk`，提示走標準輸入。
  可寫 run 開放 `Read Edit Write Glob Grep Bash`，唯讀 run 只有 `Read Glob Grep`。`--restricted`、`--settings` 是必要旗標，
  不支援就不跑（沙箱內容見 ADR 0014；worktree 的 `.git` 列在 `denyWrite` 與 `Edit(...)` 拒絕規則，不在讀取拒絕）。從
  `rate_limit_event` 取額度，從 `result` 取用量與費用。額度／登入錯誤只依結構化欄位（`rate_limit_event`、assistant 的
  `error`、`api_error_status`）與 CLI 自己的文字（stderr、模型尚未輸出時的 result）判定，模型寫的文字不算。
  **不使用任何跳過權限檢查的參數。**
- **codex**：SDK `startThread({ workingDirectory, approvalPolicy: 'never', model, modelReasoningEffort,
  skipGitRepoCheck: true })` + `runStreamed(prompt, { outputSchema, signal })`；沙箱用權限設定檔（`default_permissions` +
  拒絕清單 + `allow_network`，worktree 的 `.git` 唯讀），不傳 `--sandbox`（ADR 0014）。`--ignore-user-config`、
  `--ignore-rules` 是必要旗標（不支援 → runner 不可用）；group wrapper 無法把這些參數放到 `exec` 之後時不啟動 codex。
  只有收到 `turn.completed` 才接受最後一則 `agent_message`。
- **dsh**：`sandbox-exec -p <worker 設定檔> dsh --profile headless --patch <run>/dsh.patch.yml --json -`；事件
  `session`／`status`／`final`；無 schema 強制，最後一個 `turn_end` 是 `completed` 才取 `final.text` 中第一個完整 JSON
  物件。整個 dsh 行程在 Seatbelt 內：讀寫只限 worktree、run 自己的 `dsh-state/`（patch 把 session 與 storage 導到這裡）
  與暫存目錄，`~/.dsh` 只開放 `profiles/headless`（允許清單），DATA、`.env`、憑證目錄拒絕，服務的埠在任何位址都連不到，
  訊號與 unix socket 同機器檢查；dsh 自己的
  bash 沙箱無法巢狀（macOS 拒絕），在外層沙箱內改用 `danger-full-access`。沒有 `sandbox-exec` → runner 不可用，除非
  `runners.dsh.allow_unsandboxed: true`（此時用 dsh 自己的 workspace-write／read-only）。hub 的整理呼叫走同一個 runner
  （唯讀、沒有 worktree）。**dsh 拿不到 `OPENROUTER_API_KEY`**：服務端在 127.0.0.1 跑金鑰代理，每個 run 發一個隨機權杖
  （run 結束即撤銷），patch 把 OpenRouter 路由的 `baseURL` 指到代理、`apiKeyEnv` 讀這個權杖；代理只接受有效權杖、只轉送
  `POST /api/v1/chat/completions` 到固定的 `https://openrouter.ai`，換上真金鑰後串流回傳；dsh 的設定檔只放行代理這一個
  埠（ADR 0020）。另設 `DSH_TELEMETRY_DISABLED=1`、`NO_PROXY` 含 loopback；git 用
  `GIT_CONFIG_GLOBAL=/dev/null` 與空的 `XDG_CONFIG_HOME`（dsh 會丟掉名稱含 KEY 的變數；ADR 0019）。
- **fake**：一支照劇本檔執行的假 CLI，會把它收到的參數與環境變數記下來，可加速時間。所有非冒煙測試都用它。

派工提示 = 固定的 worker 規則 + 派工單原文 + 回執 schema + `dispatch_id`（+ 重啟復原時的復原說明）。派工單、實作者摘要、
檔案清單、diff、修正要求都包在帶本次 dispatch id 的 `<<<DATA …>>>`／`<<<END …>>>` 區塊內，規則明言那是資料不是指令。
worker 規則：只改 owned_paths；不 commit、不 push；不要提問，解決不了就回報 blocked 並結束；不印出環境變數或 `.env`；最後只輸出回執。

## 8. Engine

單一寫入者。由事件觸發，另有數秒一次的巡檢。

- **排程**：取 `queued`，依 priority、建立時間。每角色不超過 `roles.<role>.slots`，全域不超過總上限，
  並**保留一個槽位給人直接觸發的動作**。與進行中任務的 `owned_paths` 有交集就不派（不確定視為有交集）。
- **派工前檢查**：基底分支若已偏離建立 worktree 時的 `base_sha`（或人已接受的 `accepted_base_sha`）且與 owned_paths 有關：
  乾淨的 worktree 直接移到新基底；有修改則阻塞並開待決事項「重建 worktree／照舊繼續」，回答即執行
  （`rebuildWorkspace`：捨棄並在新基底重建、以全新 impl 重排；`acceptNewBase`：記下新基底、照舊繼續）。不消耗重試額度；
  這種阻塞不能用一般 retry 解除（ADR 0004）。
- **選模型**：`resolveRole(role, quotaState)`：主力在冷卻中就依序取 fallback，並套用 `rules.quota`。
- **派工結果**四種：`accepted`、`rejected`、`unknown`（→ `start_unknown`，不自動重送，開 attention）、`deferred`（槽位滿，延後）。
- **錯誤**：`rate_limit` → runner 冷卻到 `resetsAt` 加 60 秒與 0–30 秒的固定抖動（由 runner 名稱與重置時間推導）；
  `resetsAt` 不明、在過去或超過 8 天後 → 15 分鐘。任務回 `queued`，不計 attempts。額度用完（`quota.exhausted`）的停用與
  leader 自己的 rate limit 用同一個上限與緩衝。冷卻結束後第一個開始的 run 又撞到 rate limit 算一圈（冷卻前已在跑的不算），
  連續 `engine.rate_limit_loop_limit`（3）圈、中間沒有成功 → 停止自動恢復：熔斷開著、開一筆待決事項、照冷卻改用 fallback；
  成功的 run 歸零，人回答該事項或人重試會用到它的任務才重新啟用（ADR 0022）。
  其他 → `attempts+1`，指數退避（5 秒起、上限 5 分鐘），達上限 `failed`。同一 runner 連續失敗 3 次 → 熔斷並通知。
- **啟動復原**：遺留的 `starting|running` run 先處理它的 worker：記錄的 pid 與 OS 啟動時間都相符才終止整個群組（連同
  離開群組的後代）；再終止該 run 有擁有權證明的遺留行程（同 §7；只剩群組成員而它們被證明並清掉 → 群組已不在）。
  無法確認已結束（已 spawn 但沒記到 pid、只剩無法證明的群組成員、證明了卻殺不掉…）就**不重排**：任務 `blocked`、開待決
  事項、只有人能重試（ADR 0015、0022）。讀不到行程表的平台只處理群組。
  其餘標為 `abandoned`；任務回 `queued`（審查 run 則留在 `review` 重新審查）並在下一次提示附上復原說明；資料庫裡沒有
  對應紀錄的 worktree 目錄移除；未完成的 effect 繼續執行。前一個 worker 可能還活著時，絕不派第二個進同一個 worktree。
- **正常關機**：終止執行中 worker 的整個行程群組並中止進行中的機器檢查（AbortSignal；verify effect 留到下次），把 run
  依同樣規則標為 `abandoned`、任務重新排入，所以下次啟動沒有東西要修（當機時由啟動復原補做；ADR 0005）。
- **熔斷半開**：冷卻期過後只放行一個試探 run，成功才關閉、失敗立即再開。
- **effect lane**：同一 lane 保序、不同 lane 並行；一個 effect 結束後立刻接著跑同 lane 的下一個，不等巡檢。
- **清理**：定時移除已完成任務的 worktree（預設完成後 72 小時；分支保留）。
- 每個狀態變化寫一筆 `event`。另有三種非狀態事件給看板即時更新：`leader.status_changed`（idle／busy／offline 與
  可用性）、`run.log_advanced`（執行中 run 的日誌變長，只帶 run id 與位元組位置，每個 run 每 2 秒最多一筆；ADR 0013）、
  `task.waiting`（排隊的任務為什麼還沒派：`path_overlap` 與哪一張、`no_slot`、`runner_cooldown`、`backoff`、
  `worker_alive`、`base_drift`；原因改變才寫、每個任務每 30 秒最多一筆；看板卡片顯示目前的原因）。
- 服務關機中止的 effect（例如執行中的機器檢查）不算失敗、不消耗重試次數，下次啟動照原樣重跑。

## 9. Leader

`apps/server` 持有一個無頭 Claude 對話（session id 存 `kv`）。是否啟用由 `service.json` 的 `leader.enabled`（預設 true）
決定，與 worker 用不用假 runner 無關：`AGENT_TEAM_FAKE_RUNNERS=1` + 真的 leader 是最便宜的真實端到端組合。

- 每則輸入：`claude -p --resume <id>`（首次 `--session-id`），精簡啟動：`--safe-mode --strict-mcp-config
  --mcp-config '{"mcpServers":{}}' --restricted --settings <沙箱> --tools Bash`，`--allowedTools` 只放行 leader 用得到的
  `team` 子指令，`--disallowedTools` 明確拒絕 Claude Code 會自動核准的唯讀指令（`ls`、`cat`、`echo`、`pwd`…），
  `--permission-mode dontAsk --permission-prompts none`。`--restricted`、`--safe-mode`、`--disallowedTools`、
  `--permission-prompts`、`--settings` 都是必要旗標：probe 找不到任何一個 leader 就不可用並說明缺哪個。Bash 在 Claude Code
  的沙箱內：DATA 與家目錄拒讀，只開放 shim、空的工作目錄、leader 的 listener 檔與 turn-key、CLI 的 dist 與 node_modules；
  網路沒有任何網域、沒有 loopback，只有 unix socket `DATA/leader/api.sock`（shim 的 `team` 經它連服務）。剩下的範圍與
  實測見 ADR 0012。模型取角色 `leader`。
- 輸入：人的訊息（任何入口）與服務端合併後的事件批次。序列處理；`client_msg_id` 去重。事件批次在
  `leader.event_window_ms`（預設 15 秒）內沒有新事件才送出，最晚 `event_max_wait_ms`（60 秒），每批最多
  `digest_max_events`（30）則。
- 重放：每則輸入在 spawn 前於 kv 記「turn 已開始」，回覆存好（或確定失敗）才清除；仍有標記的輸入再跑時提示前面加一段
  「可能已經做過，先 `team task list` 確認」。turn 期間 shim 以 `DATA/leader/turn-key` 帶入種子，`team task add` 以
  「種子 + 內容雜湊」當 Idempotency-Key，同一個請求重放時伺服器回原結果、不重複建立（ADR 0012）。
- `--append-system-prompt`：只做受理、拆解、派工、回報；不自己改程式碼；任務細節一律用 `team` 查，不憑記憶；
  需要人決定就 `team attention open`；回覆要短；回報任務狀況時轉述指令輸出的 `report` 那一行，`delivery` 不是 `running`
  就不說任務在執行（提示 v5，ADR 0022）。
- 上下文超過門檻（預設 60000 token）送 `/compact`。關鍵狀態全在資料庫，壓縮後丟失細節是預期行為。
- leader 用的 `team` 子集**不含**讀取 run 日誌或對話的指令。
- `GET /resume` 產生不經模型的現況摘要，供新對話或換登入後接手。
- leader 用 leader 專用權杖呼叫 API（伺服器據此判定身分）。只有人能做：驗收通過／退回、回答待決事項、改派、建專案、
  reset。leader 的重試不重置 attempts、每個任務有上限（`engine.leader_retry_budget`），`start_unknown`、無法確認 worker
  已結束、`failed` 的任務不能由 leader 重試（ADR 0014）。
- `team leader reset`（`POST /leader/reset`，只有人能做）：開新對話（新 session id，第一個 turn 先附現況摘要），
  例如換了一個 Claude 登入；未登入或額度用完時 leader 標為不可用，訊息保留、恢復後依序回覆。

## 10. 中樞與 Grok

`service.json` 的 `grok.enabled` 控制，**預設關閉**（現有的中樞 session 監看同一個收件匣，不能同時開）。

- 進：`grokmsg watch` → `grokmsg read <id>` → 原文寫入 message（去重鍵 = grokmsg id）→ 交給 leader。
- 出：一律先寫 `outbox` 再發送（effect）；送出成功即記 `hub:sent:<signature>`，effect 重跑時不重送；待決事項先寫
  anchor 再送（notify 只能在送出後寫）。保序的單位：回覆同一則 Grok 訊息的「處理中」與最終回覆保序；主動通知
  依任務保序；兩者分開，失敗退避中的通知不會卡住回覆。leader 的回覆超過門檻時用角色 `hub_summarizer` 整理；
  待決事項的問題與選項不經模型，原樣以 `--question`、`--option` 傳遞。
- 選項按鈕只在送出當下**全部只有一筆**待決事項、它不是 high 風險（`topic` 的風險表）、有選項、問題與每個選項都不截斷地
  放得下（`grok.buttons`）時才帶；否則送純文字，問題與選項原樣，指向看板或 CLI（`team attention answer <id> …`），high 的
  另外說明只能在那裡回答。Grok 來的回答（按鈕或選項原文）在收到時用同一個判斷：已不是唯一的待決事項、已處理過或是
  high → 不記錄，回一句原因（ADR 0022）。
- 主動回報 `grokmsg notify`：任務完成／失敗、待決事項、阻塞、額度用完、worker 無回執、runner 熔斷。
  每則有 `signature`，相同特徵不重發（服務重啟後亦然）；同類進度在時間窗內合併；待決與額度不合併、不受安靜時段限制。
- 整理失敗送截短原文並標「（未整理）」。

## 11. API、驗證與區網

**兩個監聽埠。**

- **本機**：`127.0.0.1:4517`。只接受兩種權杖（Bearer）：operator（`listener.json`，人）與 leader（`leader/listener.json`），
  身分由權杖決定，不接受任何宣稱身分的標頭。不提供看板頁面。CLI 與 MCP 走這個。訊息的 `source` 與回答的 `via` 只由監聽埠
  與憑證推導（區網 `web`；operator `cli`，含 MCP），請求內容裡的值忽略；`client_msg_id` 不得用伺服器前綴。
- **區網**：`service.json` 的 `lan.enabled`（預設開啟）、`lan.host`（預設 `0.0.0.0`）、`lan.port`（預設 4518）。
  - **沒有驗證、沒有來源檢查、沒有主機檢查**（擁有者 2026-11-22 的決定，ADR 0024）：不登入、不檢查 `Origin`／
    `Sec-Fetch-Site`／`Host`；每個請求都是人（human），權限與本機 operator 權杖相同（含建專案、`leader reset`）。
    同一網路的任何裝置、以及網路上任何瀏覽器裡開著的網頁都能操作看板、派工，而任務會在這台電腦上執行程式碼。
  - 僅有的限制：`lan.enabled: false`（關閉）或 `lan.host: "127.0.0.1"`（只限這台電腦；這台電腦瀏覽器裡的網頁仍可操作）。
  - 不送 CORS 標頭（其他網站的網頁讀不到回應，但可以送出不需預檢的請求）。請求解析照舊：宣告了 JSON 本文的路由拒絕
    其他 Content-Type。
  - 路由守衛（leader 禁用）把 `HEAD` 視為 `GET`，受保護路徑上未註冊的方法一律拒絕。
  - 區網內為未加密 HTTP；TLS 交給反向代理，v1 不做。
  - 看板（`apps/web/dist`）只由區網監聽埠提供；在這台電腦上也是開區網埠（例如 `http://127.0.0.1:4518`）。
  - `team serve` 印出看板網址（這台電腦與各區網位址）；綁定非 loopback 位址時另印一行「沒有任何驗證」的提醒。

路由（`/api` 下，皆有 Zod 請求與回應 schema，錯誤一律 `{ error: { code, message, hint? } }`）：

```
GET  /state                         看板快照；每個任務附最近一次 run（別名、runner、狀態、費用、用量、起訖時間）、
                                    workspace 的 head_sha 與 run 合計，卡片不必再各自請求；summary：五欄計數（加總等於
                                    total，已取消另計）與一行 report
GET  /events?after=<seq>            SSE：首幀 server.connected，15 秒心跳，帶游標補發；每連線有上限的佇列，溢出只斷該連線
GET/POST /projects    PATCH /projects/:id（只改 checks；只有人可以）
GET/POST /tasks        GET /tasks/:id
POST /tasks/:id/{queue,cancel,retry,approve,reject}      POST /tasks/:id/reassign { role }
                                    任務指令都回 { task, delivery, report }：等一次排程（最多 3 秒）後依現況推導
                                    delivery（running|queued+等待原因|draft|done|not_accepted+原因），report 是程式產生的
                                    一行繁中；同一個 Idempotency-Key 重放時依現況重算（ADR 0022）
POST /research { project_id, title, question, queue? }    GET /research/:id（調研任務與結果；第 17 節）
GET  /projects/:id/memory/search    GET/POST /projects/:id/memory    POST /projects/:id/memory/:memory_id/delete（第 18 節）
GET  /runs/:id/log?tail=            只給人看
POST /leader/messages { text, source, client_msg_id, wait? } → { message_id, pending, reply?, reply_message_id?, leader }
                                    wait=false：存好就回 pending；wait=true（預設）最多等 leader.reply_wait_ms（240 秒，
                                    低於 Node fetch 的 300 秒標頭逾時），之後回 pending 而不是錯誤
GET  /leader/messages?after=&limit=     GET /leader/messages/:id（一則輸入與它的回覆）    POST /leader/reset（僅本機）
GET/POST /attention    POST /attention/:id/answer { answer, via }
GET  /resume    GET /quota    GET /doctor    GET /roles（models.json 的角色：說明、別名、runner、槽位、啟用、fallback）
```

## 12. CLI 與 MCP

`team` 讀 `listener.json` 連線；每個指令輸出要短，`--json` 給機器；結束碼 0 成功、1 業務錯誤、2 用法或連線錯誤。

```
team serve | status | doctor | resume | roles | watch [--after seq]
team project add <name> <repo> [--base B] [--check "name=cmd"]… [--allow-network]
team project update <project> (--check "name=cmd"… | --clear-checks)   # 只有人可以；整份取代，下次驗證起生效
team task add --project P --title T --tier C --paths "…" (--ticket-file F | -) [--queue]
team task list | show <id> | queue|cancel|retry <id> | reassign <id> <role>
team receipt <task_id>
team ask "<text>"
team leader reset
team attention list | show <id> | open --question Q --option A … [--task T] | answer <id> "<answer>"
```

`team task add|queue|cancel|retry`、`team research add` 在純文字與 `--json` 都印出 `delivery` 與 `report`（被拒、連不上、
用法錯誤時是 `not_accepted` 與原因，結束碼不變）；`team status` 印 `report:` 一行（五欄計數，加總等於總數）。
`team ask` 一直等到回覆（伺服器回 pending 就改為輪詢 `GET /leader/messages/:id`），Ctrl-C 只停止等待、訊息保留；
`team task reassign` 先以 `GET /roles` 檢查角色存在且啟用。`pnpm start` 先建置（需要時）再從 `dist` 啟動服務。

MCP 工具（薄包裝）：`ask_leader`（與 `team ask` 相同的等待方式，可被呼叫端取消）、`status`、`list_attention`、
`answer_attention`、`task_action`。

## 13. 看板

繁體中文介面，淺色與深色皆可讀，手機寬度可用。

- 頂部：leader 狀態、三家 runner 可用性與額度、未決事項數。
- 五欄看板；卡片：標題、tier、執行者、耗時、用量／費用（估算值標「≈… 估算」）、commit、狀態；排隊中的卡片顯示等待原因
  （`task.waiting`）。
- 卡片抽屜：派工單、回執、審查發現、run 清單、日誌尾段；操作：改派（角色清單來自 `GET /roles`；請求進行中不重送）、
  重試、停止、通過、退回。
- 待決事項：問題 + 選項按鈕。聊天面板：直接對 leader（不等待：送出後回覆經 `leader.reply` 事件出現）。
- 即時：訂閱 `/events`，斷線後用最後的 `seq` 接續；收到事件後重新讀取受影響的資源（對照表是一張以全部事件型別為鍵的表，
  新增事件型別時型別檢查會在那裡失敗）。日誌尾段跟著 `run.log_advanced`，頂部的 leader 狀態跟著 `leader.status_changed`。
- 不需登入（區網監聽埠沒有驗證，ADR 0024）。

## 14. 測試

| 層 | 內容 |
|---|---|
| core 單元 | 記憶體 repositories + 假 runner：轉換表、樂觀鎖、路徑交集、每條拒絕路徑、越界檔案、修正與升級、冷卻與改派、槽位與保留槽、四種派工結果、啟動復原、effect 的重試與世代 |
| db | 每個 SQLite repository 對照記憶體版跑同一組契約測試；遷移可從空庫套用 |
| runners | 用假 CLI 與錄製的 fixture 驗證解析、參數組裝、逾時終止行程群組、標準輸入已關閉、日誌遮蔽 |
| git | 暫存倉庫：worktree 建立與移除、變更清單、代 commit、基底漂移 |
| server | 行程內路由測試；專門的權杖驗證、區網無驗證、冪等、SSE 游標與溢出測試 |
| 端到端 | 假 runner：建專案 → 派任務 → 完成並有服務端 commit；另一條走拒絕 → 修正 → 升級 |
| web | Playwright 一條：開看板（不登入）、看到看板、回答一筆待決事項 |
| 冒煙 | 真實 runner，各一條，`TEAM_SMOKE=1` 才跑 |

測試不得碰 `~/.agent-team`、`~/RanoLabs`，不得呼叫真實模型（冒煙除外）。

## 15. 設計依據

| 做法 | 來源 |
|---|---|
| 分層工作區、合約先行、共用客戶端、事件兩層、待決事項是伺服器狀態 | opencode |
| effect 表（序號與世代）、outbox、queue-only ports、記憶體 repositories、保留槽位、復原說明 | dsh-superagent-prototype |
| workspace／run 分層、結束訊號與行程結束賽跑、服務端 commit、孤兒清理、MCP 薄包裝 | vibe-kanban |
| dispatch_id 當柵欄、冪等請求表、四種派工結果、基底漂移檢查、照劇本的假 CLI、參數探測 | Orca |
| 變更紀錄 + SSE 游標、提醒特徵去重、本機與區網兩個監聽埠 | agent-orchestrator |
| listener 檔、錯誤信封與結束碼、選用能力介面、邊界檢查腳本、檔案行數上限、ADR | Tutti |
| 訊息的客戶端編號去重 | happy |

刻意不做：Electron 與常駐的每對話 sidecar、執行期下載 agent、跨機器聯邦、外掛市集、在虛擬終端機裡跑互動介面、
讓協調者取得對話內容的指令（Tutti 的 `agent get` 是 token 翻倍的來源）。

## 16. v1 不做

分支自動合併回主幹、提交前的檔案租約 hook、主動推送喚醒桌面端、自動輪換帳號、Jev 判定關卡、TLS、多使用者。

## 17. 調研階段（可選）

規劃前先查有沒有可參考的開源專案。它是一種任務，不是每個任務都跑的固定步驟（ADR 0021）。

- **資料**：`task.kind`（`impl` 預設｜`research`）、`task.research_refs[]`（同專案、已完成的調研任務 id，最多 3 個）；
  `run.kind` 增加 `research`。調研任務沒有 worktree、沒有 `owned_paths`、沒有機器檢查、沒有審查 run：
  `draft → queued → running → done`，旁支 `blocked`／`failed`／`cancelled`。
- **回執**：
  ```
  ResearchReceipt { dispatch_id, status(done|blocked|failed), summary(≤600字),
                    candidates[≤8]{ name(≤80), url(https, ≤400), license(SPDX 或 unknown, ≤40),
                                    fit(high|medium|low), borrow(≤300：值得參考什麼), caveats(≤200) },
                    recommendation(adopt_dependency|adapt_pattern|reference_only|build_from_scratch),
                    needs_leader(≤600) }
  ```
  核對：Zod、`dispatch_id`、每個 `url` 是 `https:` 且不含帳密；字串照常遮蔽後儲存。服務端不連網驗證連結，
  看板與 CLI 標示「連結未經服務端驗證」。`done` → 任務 `done`、寫 `research.completed` 事件。
  格式失誤比照 ADR 0017 先正規化：超長的字串截到上限、超過 8 個的候選捨去、缺的 `needs_leader` 補空字串；遮蔽之後
  再截一次並重新驗證網址（遮蔽可能改變網址）。不過的回執 → run `rejected`、任務照退避重排並用掉一次 attempts（沒有
  修正輪：沒有東西可修）。`blocked`／`failed` → 任務 `blocked`，`needs_leader` 開待決事項，回答後自動重排（同 §6）。
  交給 runner 的 JSON schema 只有形狀（不含 `format`／`pattern`），網址規則由服務端檢查。
- **執行**：角色 `oss_researcher`。runner 以 `probe()` 宣告 `webSearch` 能力，`resolveRole` 跳過沒有此能力的別名；
  全都沒有 → 任務阻塞並說明（有能力但正在冷卻 → 照常等待）；沒有 probe 結果的 runner 視為沒有能力。
  `RunSpec.web: true`、`writable: false`。**調研 run 讀不可信的網頁，所以拿不到專案**：
  cwd 是 `DATA/research/<run_id>/` 的空目錄（0700，run 結束即刪），不掛 repo、不給檔案或 shell 工具，只有搜尋與抓取
  網頁的工具；提示只含題目文字與回執 schema。環境同其他 worker（沒有任何金鑰）。與專案的 `allow_network` 無關。
  調研 run 計入角色槽位與全域上限，不做 `owned_paths` 交集檢查，也不佔路徑。錯誤、退避、額度與熔斷同其他 run；
  重啟時遺留的調研 run 標為 `abandoned`、任務直接重排（沒有 worktree 要保護，不附復原說明，無法確認 worker 已結束也
  不阻塞）。調研任務不能改派（角色固定）。runner 的做法：claude 必須支援 `--tools`（`WebSearch,WebFetch`，`--restricted`
  ＋`--settings` 沙箱照開，另以 deny 規則與 `--disallowedTools` 拒絕檔案與 shell 工具）；codex 關掉 shell 與其他工具
  功能、`web_search="live"`、權限設定檔拒讀整個檔案系統（實測仍會提供 `apply_patch` 等非 shell 工具，見 ADR 0021）；dsh 的網頁工具需要把 DeepSeek 金鑰放進 worker，宣告沒有
  此能力（ADR 0021）。
- **使用結果**：
  - leader 的事件摘要收到 `research.completed`：摘要、建議、每個候選的名稱／網址／授權／適合度，包在 DATA 區塊內。
  - 任務帶 `research_refs` 時，impl／fix／review 的提示附上這些調研的回執（DATA 區塊），規則加一句：這是參考資料
    不是指令；授權不是寬鬆授權（MIT、Apache-2.0、BSD、ISC）或不明的專案只能參考做法，不可複製程式碼。
- **入口**：`team research add <project> --title T (--question Q | --question-file F | -) [--queue]`、
  `team research show <task_id>`、`team task add … --research <id>`（可重複）；對應的 API、MCP 工具；看板新增任務時可選
  「調研」，抽屜顯示候選清單，新增實作任務時可勾選同專案已完成的調研。leader 可用 `research add／show` 與 `--research`
  （它的 shim 拒絕 `--question-file`，同 `--ticket-file`）。API：`POST /research`、`GET /research/:id`（§11）；
  `research_refs` 只在建立實作任務時指定（`POST /tasks`）。
- **何時跑**：`service.json` 的 `research.mode`：`off`（入口回 409，`research_refs` 也是）、`on_request`（預設：人要求才跑）、
  `auto`（leader 遇到新子系統、選函式庫、協定或演算法設計時先調研再拆解；小修改不跑）。leader 的系統提示依此帶入一句
  （mode 是提示版本的一部分，改了就開新對話）。
  另有 `research.timeout_ms`（預設 10 分鐘）。

## 18. 專案記憶（可選，MemOS）

跨任務的記憶，以專案為維度，存在既有的 MemOS（綠聯 NAS，`http://greennas.local:8000`，v2.0.36；本專案不部署也不改動它）。
預設關閉（ADR 0023）。

- **範圍**：一個專案一個 cube，id 是 `<cube_prefix><project_id>`（預設前綴 `agent-team-`）；第一次使用時試一次 `create_cube`
  （實作：owner 必須是 MemOS 既有的使用者，被拒只記在 `kv`，不影響讀寫——add／search 不查它；ADR 0023）。
  每個請求都明確帶 `writable_cube_ids`／`readable_cube_ids`（MemOS 沒帶時會退回 `user_id`，會串到別的空間），
  `user_id` 固定為設定值。不同專案之間互相讀不到；本服務絕不讀寫沒有此前綴的 cube。
- **介面**：`core` 的 `MemoryPort`（`search(projectId, query, limit)`、`add(projectId, item)`、`list`、`remove`）；
  HTTP 實作只在 `apps/server`。worker 與 leader 拿不到 MemOS 的位址，沙箱也連不到它（記憶開啟時：dsh 與機器檢查在
  所有位址拒絕 MemOS 的埠，claude worker 開網路時以 `deniedDomains` 拒絕它，調研 run 拒絕 WebFetch 它；ADR 0023）。
- **寫入只來自服務端**，經 effect 表（lane `memory`，鍵＝來源 id，重試不重複寫）：
  - 任務 `done`：標題、最後一份實作回執的摘要、審查中 `must_fix` 且已修掉的發現（`source=task`）。
  - 人回答待決事項：問題與答案（`source=decision`；實作只寫 `general`、`worker_question` 類且屬於某個任務的事項，運作類
    與沒有任務的不寫）。
  - 人手動加入：`team memory add`（`source=human`）。
  - 調研完成：建議與候選的名稱／授權（`source=research`；內容源自網頁，讀出時標示）。
  不寫入：worker 的原始輸出、日誌、diff、被拒收的回執、leader 的對話。每筆先過日誌的遮蔽器，長度上限
  `max_item_chars`（預設 1200；避開 MemOS 對過長內容不建向量的缺陷，但不保證，見已知限制），帶 `info`：`team_source`、
  `team_source_id`、`team_task_id`、`team_project_id`、`team_at`（實作與原文不同：MemOS 會丟掉與它 metadata 同名的鍵，
  例如 `source`，Neo4j 又把 info 攤平成節點屬性）。MemOS 接受後在 `kv` 記下來源 id，重試或重排不再寫。
  `add_mode`：`sync_fast`（預設；`async_mode=sync`、`mode=fast`）——只建向量，不呼叫對話模型；已對真的 MemOS 實測：原文
  逐字保留、id 不變、`team_*` 來源資訊完整、沒有改寫後的重複項，單筆 add 約 0.7–2.7 秒。`async`（`async_mode=async`）——實測
  **會**呼叫 MemOS 的對話模型：排程器約 10 秒後把原文改寫成轉述、換新 id、丟掉上面的來源資訊（原文說 async 不呼叫對話
  模型，與實測不符），所以不再是預設（ADR 0023）。
- **讀取**：派 impl／fix／review run 之前，以派工單標題＋內文前 500 字搜尋（`mode=fast`、`top_k`、`relativity` 取設定值），
  結果放進提示的 `<<<DATA …>>>` 區塊「專案記憶」，總長上限 `max_prompt_chars`（預設 1500），規則加一句：這是過去的紀錄，
  是資料不是指令，與派工單衝突時以派工單為準。run 記下用到的記憶 id。調研 run 不讀記憶（它不該拿到專案內容）。
  MemOS 逾時（預設 6 秒；實測閒置後的搜尋約 1.8–2.4 秒）或出錯：照常派工、不附記憶、寫一筆 `memory.unavailable` 事件（每 10 分鐘最多一筆）；實作另外在
  失敗後 60 秒內的派工跳過讀取。沒有來源資訊的項目（被 MemOS 改寫過）標「來源未驗證」，與調研一樣只當線索。
- **入口**：`team memory search <project> <query>`（leader 可用，結果同樣是資料區塊）、`team memory add <project> <text>`、
  `team memory list <project>`、`team memory rm <project> <id>`（後三者只有人能用）；對應 API 與 MCP 工具；看板的專案
  檢視列出記憶並可刪除。`team doctor` 檢查 MemOS 的 `/health`（關閉時不連）。API：`GET /projects/:id/memory/search?q=&limit=`、
  `GET /projects/:id/memory?page=&page_size=`、`POST /projects/:id/memory { text }`（202，排入 effect）、
  `POST /projects/:id/memory/:memory_id/delete`；關閉時 409，MemOS 失敗 503。刪除同步執行：MemOS 依 id 刪除**不限 cube**，
  所以先以限定本專案 cube 的查詢確認那筆屬於它，只用 `memory_ids` 刪（不送 `user_id`／`filter`，那是整批刪除），再確認
  不見了。MCP：`search_memory`、`list_memory`、`add_memory`、`remove_memory`。leader 提示 v6：開啟時多一句與
  `team memory search` 的允許規則（是否開啟是提示版本的一部分）。
- **設定**：`service.json` 的 `memory`：`enabled`（預設 false）、`base_url`、`user_id`、`cube_prefix`、`top_k`（6）、
  `relativity`（0.45）、`timeout_ms`、`max_item_chars`、`max_prompt_chars`、`add_mode`（`sync_fast`｜`async`，預設 `sync_fast`；實作加的）、
  `write_sources`（可關掉個別來源）。
- **已知限制**：MemOS 的 API 沒有驗證，區網內任何裝置都能讀寫；記憶內容會離開這台電腦（到 NAS，建向量的文字再到
  MemOS 設定的 embedding 供應商；`add_mode=async` 時全文再到它的對話模型；預設 `sync_fast` 不會）。刪除專案不自動刪 cube。MemOS #2461：內容落在
  embedder 上限與切分門檻之間時存下但沒有向量、永遠搜不到（回報者約 500 個中文字就觸發），看板與 CLI 標「搜尋不到」。

## 19. T3 Code 編排與把關 API（ADR 0026）

規劃與派工可改由 T3 Code 的主 thread 擔任（skill `skills/t3-team`）：拆單照 §9 的規則，worker 是 T3 的
`delegate_task`（`isolation: worktree`）。服務只做把關、調研（§17）與記憶（§18）。原本的 `team task add` 路線不變，兩者並存。

**把關（gate）**：對一個不是服務建立的 worktree 做 §6 第 3–5 步。只有人（operator 權杖、區網）能呼叫；leader 一律拒絕。

```
POST /api/gate { project_id, worktree_path, base_sha, owned_paths[], commit_message?, commit? (預設 true) }
     → 202 { gate_id, state: running }
GET  /api/gate/:id
     → { gate_id, state(running|done), verdict?(pass|rejected|checks_failed), reasons[], files_changed[], out_of_scope[],
         checks[{ name, cmd, result(pass|fail|not_run), tail }], head_sha?, committed, started_at, ended_at? }
```

1. 前置（不符 → `rejected`，`reasons` 寫明）：專案存在；`worktree_path` 是絕對路徑、真實目錄（解析 symlink）、不是主
   checkout；`.git` 是一般檔案、`--git-common-dir` 是專案 repo 的、top level 就是這個路徑；HEAD 在某個分支上、不是
   專案的 `base_branch`；`base_sha` 是 HEAD 的祖先。`owned_paths` 照 `OwnedPathSchema` 驗證（400）。
2. 變更清單 = `base_sha..HEAD` 的檔案 ∪ 未提交的修改 ∪ 未追蹤且未被 ignore 的檔案（排序、去重）。空 → `rejected`
   （沒有變更）。不在 `owned_paths` 內的（core 的 `filesOutside`，依 `core.ignorecase`）→ `rejected`，列在 `out_of_scope`。
3. 專案的機器檢查逐條在 worktree 執行，用服務的檢查執行器（同 §6 第 4 步的沙箱與環境白名單；沒有沙箱就照
   `checks.allow_unsandboxed`）。日誌存 `DATA/gate/<gate_id>/<check>.log`，回應只帶最後 20 行（已遮蔽）。任一失敗 →
   `checks_failed`，不提交。專案沒有檢查 → `checks` 為空、照常繼續（`reasons` 註明「沒有機器檢查」）。
4. 重算變更清單；與第 2 步不同 → `rejected`（檢查期間多出或少了檔案），不提交。
5. `commit` 為 true 且有未提交的變更：只 `git add -- <核對過的檔案>`、不執行 hooks、作者同服務端提交，訊息預設
   `team(gate): <分支名稱>`；回傳 `head_sha`。沒有未提交的變更（worker 自己提交了，或重跑）→ 不新增提交，`committed=false`。
6. job 只存在記憶體（重啟遺失，重跑即可：gate 冪等）；同時最多 `gate.max_concurrent`（預設 2）個在跑，超過回 429。
   完成的 job 保留 1 小時。寫一筆 `gate.completed` 事件（gate_id、project_id、verdict）。

**入口**：`team gate <project> --worktree <path> --base <sha> --paths "<globs>" [--message M] [--no-commit] [--json]`
（送出後輪詢到 `done`，印出判定、越界檔案、每條檢查的結果；pass 結束碼 0、其他 1）；MCP 工具 `gate_worktree`（同樣
等到完成）。
