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
8. 憑證不進版控、不進資料庫、不進日誌、不進任何 API 回應；傳給子行程時只放它需要的那一個變數。

## 2. 技術棧

| 項目 | 選擇 |
|---|---|
| 執行環境 | Node ≥ 26、pnpm workspaces；開發用 `tsx`，正式用 `tsc -b` 產出後以 `node` 執行 |
| 語言 | TypeScript strict（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`），專案參照 |
| 結構與驗證 | Zod（領域物件、回執、事件、API 請求與回應、設定檔） |
| 服務框架 | Hono + `@hono/node-server` + `@hono/zod-openapi`；產出 `openapi.json` 並提交，CI 檢查是否漂移 |
| 型別安全的客戶端 | Hono RPC（`hc<AppType>`）包在 `packages/client`，CLI／MCP／網頁都用它 |
| 資料庫 | SQLite + Drizzle ORM；`drizzle-kit` 產生帶時間戳的 SQL 遷移，啟動時套用；WAL、`busy_timeout=5000` |
| 前端 | React + Vite + Tailwind + TanStack Query + zustand；拖放用 `@hello-pangea/dnd` |
| MCP | `@modelcontextprotocol/sdk`（stdio） |
| CLI | commander |
| Codex | `@openai/codex-sdk`，鎖定確切版本，使用它自帶的執行檔 |
| 測試 | vitest（單元、整合）；Playwright 一條看板冒煙 |
| 品質 | oxlint；格式化用 oxfmt，若在本機不可用則 prettier；`tsc -b`；husky + lint-staged |
| CI | GitHub Actions：安裝 → lint → typecheck → test → build → 檢查產生檔漂移 |

SQLite 驅動：優先 Drizzle 的 `node:sqlite` 驅動（免原生編譯）；不可用則 `better-sqlite3`。實作者在本機驗證後定案並寫 ADR。
所有依賴鎖定確切版本。不在執行期用 `npx -y` 下載任何東西。

## 3. 工作區

```
packages/schema     Zod：領域物件、狀態與轉換表、回執、事件、API DTO、設定檔。無其他依賴
packages/core       領域邏輯：ports、engine（排程、核對、升級、復原）、記憶體版 repositories。只依賴 schema
packages/db         Drizzle schema、遷移、SQLite 版 repositories（實作 core 的 ports）
packages/runners    Runner 實作：claude、codex、dsh、fake；共用的子行程工具；錄製的 fixture
packages/git        worktree 生命週期、變更清單、代 commit、基底漂移檢查（實作 core 的 ports）
packages/client     型別安全的 HTTP 客戶端 + 讀取 listener 檔的連線工具
apps/server         Hono 應用、驗證與區網監聽、SSE、組裝（wiring）、leader、hub
apps/cli            `team` 指令
apps/mcp            stdio MCP 伺服器
apps/web            看板與聊天
config/             models.json（已存在）、service.json
docs/               spec.md、adr/、conventions.md
```

依賴方向只能往上表的上方走；`apps/*` 之間互不依賴。用一支檢查腳本在 CI 裡擋住違反的 import。
單一原始檔不超過 500 行；超過就拆。每個套件有自己的 `README.md`（三五行說明職責與對外介面）。
根目錄 `AGENTS.md` 寫給 agent 看的開發規範（`CLAUDE.md` 連到它）。重要決定寫 `docs/adr/NNNN-title.md`（半頁以內）。

## 4. 路徑

| 用途 | 位置 |
|---|---|
| 資料目錄 `DATA` | `~/.agent-team/`（`AGENT_TEAM_HOME` 可覆寫；測試一律覆寫到暫存目錄） |
| 資料庫 | `DATA/team.db` |
| 連線資訊 | `DATA/run/listener.json`（權限 0600）：`{ addr, token }`，供 CLI／MCP 自動連線 |
| 執行日誌 | `DATA/runs/<run_id>/{events.jsonl, stderr.log, prompt.md}` |
| 任務 worktree | `<worktree_root>/<project>/<task_id>/`，預設 `~/RanoLabs/worktrees`，分支 `team/<task_id>` |
| 金鑰 | 專案根目錄 `.env`（git 忽略；`AGENT_TEAM_ENV_FILE` 可改指）。`packages/schema` 定義需要哪些變數，`apps/server` 提供唯一的讀取函式，一次只回傳被要求的那一個 |

## 5. 領域模型

id 用前綴 + 隨機短字串（`p_`、`t_`、`w_`、`r_`、`a_`、`m_`）。時間一律 ISO 8601 UTC。

```
project      id, name, repo_path, base_branch, checks[{name, cmd}]
task         id, project_id, parent_id?, title, tier(A|B|C), ticket_md, owned_paths[], priority,
             status, impl_role, fix_rounds, attempts, blocked_reason?, version
workspace    id, task_id, path, branch, base_sha, head_sha?, state(active|kept|removed)
run          id, task_id, workspace_id, dispatch_id(unique), kind(impl|fix|review), role, model_alias, runner, model,
             state(starting|running|succeeded|failed|start_unknown|stopped|abandoned),
             outcome?(ok|rejected|error|rate_limited|timeout|cancelled), reject_reason?,
             session_ref?, receipt?, usage?, cost_usd?, log_dir, pid?, started_at, ended_at?
attention    id, task_id?, kind(decision|approval|question), question, options[], status(open|answered|superseded),
             answer?, answered_via?
message      id, channel(leader|grok), direction(in|out), source(web|cli|mcp|grok|service), body,
             client_msg_id(unique per channel), ref?, status(new|delivered|acked), seq
event        seq(autoincrement), ts, type, task_id?, run_id?, data           -- 持久變更紀錄，SSE 的游標
effect       kind, key, payload, seq, generation, attempts, due, error?      -- PK(kind, key)
outbox       id, target(grok), kind, body, signature(unique), status(pending|sent|failed), task_id?, attempts
idempotency  caller, request_id, method, payload_hash, state(pending|completed), response   -- PK(caller, request_id)
kv           key, value
```

`task.status`：`draft → queued → running → verifying → review → done`，旁支 `blocked`、`failed`、`cancelled`。
合法轉換是 `packages/schema` 裡的一張表；狀態只由 engine 改，用 `version` 做比較後才設定（樂觀鎖）。
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

1. 回執通過 Zod；`dispatch_id` 等於該 run 的編號且該 run 仍是任務的當前 run。
2. `blocked`／`failed` → 任務進 `blocked`；`needs_leader` 非空則開一筆 attention。
3. worktree 確有變更；實際變更檔案全部落在 `owned_paths` 內（以 git 為準，不以回執自述為準）。
4. 專案的機器檢查全過（逐條執行，完整輸出存日誌，只把結果與最後 20 行留給修正單）。
5. 服務端 commit（`team(<task_id>): <title>`），記 `head_sha`。
6. 任務進 `review`，排入審查 run（`review_A|B|C`）。審查者的模型別名不得與最近一次實作 run 相同。

審查 `pass` → `done`。`needs_changes` → 修正 run（帶 must_fix 清單），`fix_rounds+1`；達到
`rules.max_fix_rounds_before_escalate` 後換 `escalate_to` 的角色；無處可升則 `blocked`。

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

共同要求：參數一律用陣列，不經 shell；標準輸入明確關閉或寫入後關閉；子行程自成行程群組，逾時或取消時終止整個群組；
完成判定是「agent 的結束訊號」與「行程結束」先到者為準；原始事件流寫 `events.jsonl`；日誌寫入前遮蔽看起來像金鑰的字串。

- **claude**：`claude -p --model … --output-format stream-json --verbose --json-schema … --safe-mode
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk`，提示走標準輸入。可寫 run 開放
  `Read Edit Write Glob Grep Bash`，唯讀 run 只有 `Read Glob Grep`。從 `rate_limit_event` 取額度，從 `result` 取用量與費用。
  **不使用任何跳過權限檢查的參數。**
- **codex**：SDK `startThread({ workingDirectory, sandboxMode, approvalPolicy: 'never', model, modelReasoningEffort,
  skipGitRepoCheck: true })` + `runStreamed(prompt, { outputSchema, signal })`。
- **dsh**：`dsh --profile headless --json -`；事件 `session`／`status`／`final`；無 schema 強制，取 `final.text` 中第一個完整
  JSON 物件。`OPENROUTER_API_KEY` 只放進子行程環境，並設 `DSH_TELEMETRY_DISABLED=1`、`DSH_PERMISSION_MODE=workspace-write`。
- **fake**：一支照劇本檔執行的假 CLI，會把它收到的參數與環境變數記下來，可加速時間。所有非冒煙測試都用它。

派工提示 = 固定的 worker 規則 + 派工單原文 + 回執 schema + `dispatch_id`（+ 重啟復原時的復原說明）。
worker 規則：只改 owned_paths；不 commit、不 push；不要提問，解決不了就回報 blocked 並結束；不印出環境變數或 `.env`；最後只輸出回執。

## 8. Engine

單一寫入者。由事件觸發，另有數秒一次的巡檢。

- **排程**：取 `queued`，依 priority、建立時間。每角色不超過 `roles.<role>.slots`，全域不超過總上限，
  並**保留一個槽位給人直接觸發的動作**。與進行中任務的 `owned_paths` 有交集就不派（不確定視為有交集）。
- **派工前檢查**：基底分支若已偏離建立 worktree 時的 `base_sha` 且與 owned_paths 有關，先重建或標記，不消耗重試額度。
- **選模型**：`resolveRole(role, quotaState)`：主力在冷卻中就依序取 fallback，並套用 `rules.quota`。
- **派工結果**四種：`accepted`、`rejected`、`unknown`（→ `start_unknown`，不自動重送，開 attention）、`deferred`（槽位滿，延後）。
- **錯誤**：`rate_limit` → runner 冷卻到 `resetsAt`（不明則 15 分鐘），任務回 `queued`，不計 attempts；
  其他 → `attempts+1`，指數退避（5 秒起、上限 5 分鐘），達上限 `failed`。同一 runner 連續失敗 3 次 → 熔斷並通知。
- **啟動復原**：遺留的 `starting|running` run 標為 `abandoned`；任務回 `queued` 並在下一次提示附上復原說明；
  資料庫裡沒有對應紀錄的 worktree 目錄移除；未完成的 effect 繼續執行。
- **清理**：定時移除已完成任務的 worktree（預設完成後 72 小時；分支保留）。
- 每個狀態變化寫一筆 `event`。

## 9. Leader

`apps/server` 持有一個無頭 Claude 對話（session id 存 `kv`）。

- 每則輸入：`claude -p --resume <id>`（首次 `--session-id`），精簡啟動：`--safe-mode --strict-mcp-config
  --mcp-config '{"mcpServers":{}}' --tools Bash`，`--allowedTools` 只放行 `team` 指令。模型取角色 `leader`。
- 輸入：人的訊息（任何入口）與服務端合併後的事件批次。序列處理；`client_msg_id` 去重。
- `--append-system-prompt`：只做受理、拆解、派工、回報；不自己改程式碼；任務細節一律用 `team` 查，不憑記憶；
  需要人決定就 `team attention open`；回覆要短。
- 上下文超過門檻（預設 60000 token）送 `/compact`。關鍵狀態全在資料庫，壓縮後丟失細節是預期行為。
- leader 用的 `team` 子集**不含**讀取 run 日誌或對話的指令。
- `GET /resume` 產生不經模型的現況摘要，供新對話或換登入後接手。

## 10. 中樞與 Grok

`service.json` 的 `grok.enabled` 控制，**預設關閉**（現有的中樞 session 監看同一個收件匣，不能同時開）。

- 進：`grokmsg watch` → `grokmsg read <id>` → 原文寫入 message（去重鍵 = grokmsg id）→ 交給 leader。
- 出：一律先寫 `outbox` 再發送（effect），同一任務的訊息保序。leader 的回覆超過門檻時用角色 `hub_summarizer` 整理；
  待決事項的問題與選項不經模型，原樣以 `--question`、`--option` 傳遞。
- 主動回報 `grokmsg notify`：任務完成／失敗、待決事項、阻塞、額度用完、worker 無回執、runner 熔斷。
  每則有 `signature`，相同特徵不重發（服務重啟後亦然）；同類進度在時間窗內合併；待決與額度不合併、不受安靜時段限制。
- 整理失敗送截短原文並標「（未整理）」。

## 11. API、驗證與區網

**兩個監聽埠。**

- **本機**：`127.0.0.1:4517`。需要 `listener.json` 裡的權杖（Bearer）。CLI 與 MCP 走這個。
- **區網**：`service.json` 的 `lan.enabled`（預設開啟）、`lan.host`（預設 `0.0.0.0`）、`lan.port`（預設 4518）。
  - 密碼取 `.env` 的 `TEAM_LAN_PASSWORD`；未設定則啟動時產生一組隨機值並只在終端機印出一次。
  - `POST /auth/login` 換取 HMAC 簽章的 session cookie（HttpOnly、SameSite=Strict、同源才接受）。常數時間比較。
  - 同一來源連續錯誤 5 次鎖定 15 分鐘。
  - 檢查 `Origin` 允許清單與 `Sec-Fetch-Site`，不符回 403。不使用寬鬆的 CORS。權杖與密碼不出現在網址。
  - 區網**不開放**：新增或修改 project（涉及本機路徑）、任何設定寫入。其餘（看板、聊天、待決事項、任務操作、日誌檢視）開放。
  - 區網內為未加密 HTTP；TLS 交給反向代理，v1 不做。

路由（`/api` 下，皆有 Zod 請求與回應 schema，錯誤一律 `{ error: { code, message, hint? } }`）：

```
GET  /state                         看板快照
GET  /events?after=<seq>            SSE：首幀 server.connected，15 秒心跳，帶游標補發；每連線有上限的佇列，溢出只斷該連線
GET/POST /projects                  （POST 僅本機）
GET/POST /tasks        GET /tasks/:id
POST /tasks/:id/{queue,cancel,retry,approve,reject}      POST /tasks/:id/reassign { role }
GET  /runs/:id/log?tail=            只給人看
POST /leader/messages { text, source, client_msg_id } → { reply }     GET /leader/messages
GET/POST /attention    POST /attention/:id/answer { answer, via }
GET  /resume    GET /quota    GET /doctor
```

## 12. CLI 與 MCP

`team` 讀 `listener.json` 連線；每個指令輸出要短，`--json` 給機器；結束碼 0 成功、1 業務錯誤、2 用法或連線錯誤。

```
team serve | status | doctor | resume | watch [--after seq]
team project add <name> <repo> [--base B] [--check "name=cmd"]…
team task add --project P --title T --tier C --paths "…" (--ticket-file F | -) [--queue]
team task list | show <id> | queue|cancel|retry <id> | reassign <id> <role>
team receipt <task_id>
team ask "<text>"
team attention list | open --question Q --option A … [--task T] | answer <id> "<answer>"
```

MCP 工具（薄包裝）：`ask_leader`、`status`、`list_attention`、`answer_attention`、`task_action`。

## 13. 看板

繁體中文介面，淺色與深色皆可讀，手機寬度可用。

- 頂部：leader 狀態、三家 runner 可用性與額度、未決事項數。
- 五欄看板；卡片：標題、tier、執行者、耗時、用量／費用、commit、狀態。
- 卡片抽屜：派工單、回執、審查發現、run 清單、日誌尾段；操作：改派、重試、停止、通過、退回。
- 待決事項：問題 + 選項按鈕。聊天面板：直接對 leader。
- 即時：訂閱 `/events`，斷線後用最後的 `seq` 接續；收到事件後重新讀取受影響的資源。
- 登入頁（區網）。

## 14. 測試

| 層 | 內容 |
|---|---|
| core 單元 | 記憶體 repositories + 假 runner：轉換表、樂觀鎖、路徑交集、每條拒絕路徑、越界檔案、修正與升級、冷卻與改派、槽位與保留槽、四種派工結果、啟動復原、effect 的重試與世代 |
| db | 每個 SQLite repository 對照記憶體版跑同一組契約測試；遷移可從空庫套用 |
| runners | 用假 CLI 與錄製的 fixture 驗證解析、參數組裝、逾時終止行程群組、標準輸入已關閉、日誌遮蔽 |
| git | 暫存倉庫：worktree 建立與移除、變更清單、代 commit、基底漂移 |
| server | 行程內路由測試；專門的驗證、來源檢查、鎖定、冪等、SSE 游標與溢出測試 |
| 端到端 | 假 runner：建專案 → 派任務 → 完成並有服務端 commit；另一條走拒絕 → 修正 → 升級 |
| web | Playwright 一條：登入、看到看板、回答一筆待決事項 |
| 冒煙 | 真實 runner，各一條，`TEAM_SMOKE=1` 才跑 |

測試不得碰 `~/.agent-team`、`~/RanoLabs`，不得呼叫真實模型（冒煙除外）。

## 15. 設計依據

| 做法 | 來源 |
|---|---|
| 分層工作區、合約先行、共用客戶端、事件兩層、待決事項是伺服器狀態 | opencode |
| effect 表（序號與世代）、outbox、queue-only ports、記憶體 repositories、保留槽位、復原說明 | dsh-superagent-prototype |
| workspace／run 分層、結束訊號與行程結束賽跑、服務端 commit、孤兒清理、MCP 薄包裝 | vibe-kanban |
| dispatch_id 當柵欄、冪等請求表、四種派工結果、基底漂移檢查、照劇本的假 CLI、參數探測 | Orca |
| 變更紀錄 + SSE 游標、提醒特徵去重、本機與區網兩個監聽埠、來源鎖定 | agent-orchestrator |
| listener 檔、錯誤信封與結束碼、選用能力介面、邊界檢查腳本、檔案行數上限、ADR | Tutti |
| 訊息的客戶端編號去重 | happy |

刻意不做：Electron 與常駐的每對話 sidecar、執行期下載 agent、跨機器聯邦、外掛市集、在虛擬終端機裡跑互動介面、
讓協調者取得對話內容的指令（Tutti 的 `agent get` 是 token 翻倍的來源）。

## 16. v1 不做

分支自動合併回主幹、提交前的檔案租約 hook、主動推送喚醒桌面端、自動輪換帳號、Jev 判定關卡、TLS、多使用者。
