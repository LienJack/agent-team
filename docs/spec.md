# agent-team v1 規格

本機多 agent 開發服務：一支 Node 行程 + SQLite + 單頁看板。Team Leader 是服務端持有的無頭 Claude 對話；
worker 是一次性的無頭行程（Claude／Codex／dsh）；人從看板聊天框、桌面端（MCP）或手機 Grok（CLI）進來。

這份文件是實作的唯一依據。與它衝突時以它為準；它沒寫到的，選最簡單的做法並在回報裡說明。

## 1. 硬性約束

- Node ≥ 26，直接執行 `.ts`（型別剝除）。因此：**只用可抹除的語法**——不用 `enum`、`namespace`、建構子參數屬性；
  相對 import 一律帶 `.ts` 副檔名；`import type` 用於純型別。
- 資料庫用內建 `node:sqlite`（`DatabaseSync`）。HTTP 用內建 `node:http`。測試用內建 `node:test`。
- **執行期依賴只允許一個**：`@openai/codex-sdk`（鎖定確切版本，只在 `src/runners/codex.ts` 內 import）。
  不引入框架、ORM、打包工具、前端框架。MCP 伺服器手寫（stdio 上的 JSON-RPC），不裝 MCP SDK。
- 服務只綁 `127.0.0.1`。不對外開埠。
- 憑證不寫檔、不進日誌、不進資料庫、不印出。
- 所有啟動子行程的地方：`stdin` 關閉或明確寫入後關閉（`codex` 沒有終端機時會一直等標準輸入）。
- worker 不 commit；由服務端核對後代做。
- 任何模型都不讀另一個 worker 的對話過程。leader 只看得到回執。

## 2. 路徑

| 用途 | 位置 |
|---|---|
| 程式碼 | 本倉庫 `src/`、`web/`、`test/`、`config/` |
| 資料目錄 `DATA` | `~/.agent-team/`（可用環境變數 `AGENT_TEAM_HOME` 覆寫；測試一律覆寫到暫存目錄） |
| 資料庫 | `DATA/team.db` |
| 執行日誌 | `DATA/runs/<run_id>/events.jsonl`、`stderr.log`、`prompt.md` |
| 任務 worktree | `<worktree_root>/<project>/<task_id>/`，`worktree_root` 預設 `~/RanoLabs/worktrees`，分支 `team/<task_id>` |

## 3. 檔案配置與擁有權

```
package.json            type: module；bin: { team: src/cli.ts }；scripts: test, serve
config/models.json      已存在。模型名單與角色分配（見其 _readme）
config/service.json     埠（預設 4517）、worktree_root、槽位總上限、leader 與 grok 設定
src/types.ts            所有共用型別（本文件第 4–6 節）
src/db.ts               開啟資料庫、建表、遷移（user_version）
src/config.ts           讀兩個設定檔；resolveRole(role, quotaState) → 模型別名與 runner
src/store.ts            所有 SQL。其他模組不直接寫 SQL
src/worktree.ts         git worktree 建立／移除、變更清單、代 commit
src/verify.ts           回執核對、機器檢查、提交、決定下一個狀態
src/dispatcher.ts       排程迴圈：槽位、路徑交集、啟動 run、處理結果、升級
src/quota.ts            記錄各 runner 的額度狀態與冷卻
src/runners/types.ts    Runner 介面
src/runners/fake.ts     測試用假 runner（由環境變數或 spec 指定行為）
src/runners/claude.ts   claude -p
src/runners/codex.ts    Codex SDK
src/runners/dsh.ts      dsh headless
src/leader.ts           無頭 leader 對話
src/hub.ts              手機訊息整理 + grokmsg 橋接
src/server.ts           HTTP API、事件串流、靜態檔
src/mcp.ts              stdio MCP 伺服器，轉呼叫 HTTP API
src/cli.ts              `team` 指令，轉呼叫 HTTP API（`team serve` 例外：啟動服務）
web/index.html          看板 + 聊天框（單檔，內嵌 CSS／JS）
test/*.test.ts
```

## 4. 資料表

時間一律 ISO 8601 UTC 字串。id 用短的可讀字串（`t_`、`r_`、`a_` 前綴 + 隨機）。

```sql
projects(id PK, name UNIQUE, repo_path, base_branch, checks_json, created_at)
  -- checks_json: [{name, cmd}]，在 worktree 內執行的機器檢查（型別檢查、測試、lint）

tasks(id PK, project_id, parent_id, title, tier, status, ticket_md, owned_paths_json,
      priority, impl_role, fix_rounds, attempts, branch, worktree, commit_sha,
      blocked_reason, created_at, updated_at)

runs(id PK, task_id, dispatch_id UNIQUE, kind, role, model_alias, runner, model, status,
     pid, session_ref, receipt_json, usage_json, cost_usd, error_kind, error_message,
     log_dir, started_at, ended_at)

messages(id PK, channel, direction, source, body, ref, status, created_at)
  -- channel: leader | grok。direction: in | out。status: new | delivered | acked

attention(id PK, task_id, question, options_json, answer, answered_via, status, created_at, answered_at)
  -- status: open | answered

events(seq INTEGER PK AUTOINCREMENT, ts, kind, task_id, run_id, data_json)
kv(key PK, value)
```

`tasks.status`：`draft → queued → running → verifying → review → done`，旁支 `blocked`、`failed`、`cancelled`。
合法轉換寫成一張表放在 `types.ts`，`store.ts` 的狀態更新用「比較後才設定」（`UPDATE … WHERE status = ?`），
不合法的轉換拋錯。

`runs.kind`：`impl | fix | review`。`runs.status`：`running | ok | rejected | error | rate_limited | timeout | cancelled`。

看板五欄的對應：待派 = draft、queued；進行中 = running、verifying；待驗收 = review；阻塞 = blocked、failed；完成 = done。

## 5. 回執

worker 最後的回答必須是符合 schema 的 JSON。三家都用各自的結構化輸出功能強制。

實作／修正回執：

```json
{ "dispatch_id": "…", "status": "done | blocked | failed",
  "summary": "≤ 600 字",
  "files_changed": ["相對路徑"],
  "checks": [{ "cmd": "…", "result": "pass | fail | not_run", "note": "…" }],
  "needs_leader": "沒有就給空字串" }
```

審查回執：

```json
{ "dispatch_id": "…", "verdict": "pass | needs_changes | blocked",
  "summary": "≤ 600 字",
  "findings": [{ "file": "…", "line": 0, "severity": "must_fix | should_fix | note", "issue": "…" }] }
```

**服務端不信任回執。** `verify.ts` 對實作／修正 run 依序檢查，任何一步不過就把 run 標為 `rejected` 並記原因：

1. 回執是合法 JSON 且符合 schema；`dispatch_id` 等於這次派工的編號（防止重試後舊結果蓋掉新狀態）。
2. `status` 為 `blocked`／`failed` → 任務進 `blocked`，`needs_leader` 寫成一筆 attention 或事件。
3. worktree 內確實有變更（`git status --porcelain`）；實際變更的檔案全部落在 `owned_paths` 內。
   以 git 看到的實際變更為準，不以回執的 `files_changed` 為準。
4. 專案的機器檢查全部通過（逐條執行，輸出存日誌，只把通過與否和最後 20 行留給後續修正單）。
5. 服務端 `git add <實際變更的檔案>` 並 commit（訊息 `team(<task_id>): <title>`），記 `commit_sha`。
6. 任務進 `review`，排入審查 run（角色依 tier：`review_A|B|C`）。

審查 `pass` → `done`。`needs_changes` → 產生修正 run（同一角色，帶上 must_fix 清單），`fix_rounds + 1`。
`fix_rounds` 達到 `rules.max_fix_rounds_before_escalate` 後改用 `escalate_to` 的角色；沒有可升級的角色就進 `blocked`。
審查者的模型別名不得與該任務最近一次實作 run 相同；相同時取 fallback 的下一個。

## 6. Runner 介面

```ts
type RunSpec = {
  dispatchId: string; cwd: string; prompt: string; schema: object;
  model: string; effort?: string; writable: boolean;   // 審查 run 為 false
  logDir: string; timeoutMs: number; env?: Record<string, string>;
};
type RunError = { kind: 'rate_limit' | 'auth' | 'timeout' | 'crash' | 'bad_output'; message: string };
type RunResult = {
  receipt?: unknown;            // 已 JSON.parse 的最後回答；解析失敗則缺省並給 error.bad_output
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number; sessionRef?: string; error?: RunError;
  quota?: { utilization?: number; resetsAt?: string; exhausted?: boolean };
};
interface Runner { name: 'claude' | 'codex' | 'dsh' | 'fake'; run(spec: RunSpec, signal: AbortSignal): Promise<RunResult>; }
```

共同要求：把原始事件流寫到 `logDir/events.jsonl`、標準錯誤寫到 `stderr.log`；子行程自成行程群組，
逾時或取消時終止整個群組；絕不把憑證寫進日誌。

- **claude**：`claude -p --model <id> --output-format stream-json --verbose --json-schema <schema>
  --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk`，提示走標準輸入，
  `cwd` 為 worktree。可寫 run 開放 `Read Edit Write Glob Grep Bash`；唯讀 run 只開放 `Read Glob Grep`。
  從事件流的 `rate_limit_event` 取額度（`unifiedWindows` 的 utilization、resetsAt），從 `result` 事件取用量與費用。
  參數以本機 `claude --help` 為準；與此處不符時照實際可用的參數並在回報說明。
- **codex**：`new Codex().startThread({ workingDirectory, sandboxMode: writable ? 'workspace-write' : 'read-only',
  approvalPolicy: 'never', model, modelReasoningEffort, skipGitRepoCheck: true })`，`runStreamed(prompt, { outputSchema, signal })`。
  使用 SDK 自帶的執行檔，不要指向另外安裝的版本。最後一個 `agent_message` 即回執。
- **dsh**：`dsh --profile headless --json -`，提示走標準輸入。事件為 `session`／`status`／`final`；
  `final.text` 即回執文字（dsh 沒有 schema 強制，取文字中第一個完整 JSON 物件，失敗則 `bad_output`）。
  模型用環境變數或 `--patch` 指定（實作時以 `dsh --profile headless --dump-config-schema` 與
  vfx-monorepo 的 `fx-studio/server/agents/devworker.py` 為參考，唯讀）。
  `OPENROUTER_API_KEY`：先看環境變數，沒有才從本專案根目錄的 `.env` 讀（git 忽略；範本見 `.env.example`；
  `AGENT_TEAM_ENV_FILE` 可改指別的檔案）。`src/config.ts` 提供唯一的讀取函式，只回傳被要求的那個變數，
  只放進子行程環境。同時設 `DSH_TELEMETRY_DISABLED=1`、`DSH_PERMISSION_MODE=workspace-write`。

派工提示由 `dispatcher.ts` 組成：固定的 worker 規則 + 派工單原文 + 回執 schema + `dispatch_id`。
worker 規則至少包含：只改 owned_paths 內的檔案；不要 commit、不要 push；不要提問，無法解決就回報 blocked；
不要印出環境變數或任何 `.env`；最後只輸出回執 JSON。

## 7. 排程

`dispatcher.ts` 是單一迴圈（事件觸發 + 每數秒巡一次）：

- 取 `queued` 的任務，依 priority、建立時間排序。
- 槽位：每個角色不超過 `roles.<role>.slots`；全域不超過 `service.json` 的總上限。
- 路徑交集：與任何進行中任務（running／verifying／review）的 `owned_paths` 有交集就不派，留在佇列。
  交集判定用路徑前綴與 glob 的保守比較（不確定就視為有交集）。
- 角色 → 模型：`config.resolveRole`。若該 runner 在冷卻中（`quota.ts`），依序取 fallback；全部不可用則任務留在佇列。
  `rules.quota` 的改派規則在此套用。
- run 結果為 `rate_limit` → 該 runner 進入冷卻直到 `resetsAt`（不明則 15 分鐘），任務回到 `queued`，
  不計入 `attempts`，寫一筆 `quota_exhausted` 事件。
- 其他錯誤 → `attempts + 1`，未達上限（預設 2）則重排，達上限進 `failed`。
- 服務啟動時：把上次遺留的 `running` run 標為 `error`（crash），對應任務回到 `queued`。

每個狀態變化都寫一筆 `events`。事件種類至少：`task_created`、`task_queued`、`run_started`、`run_finished`、
`task_review`、`task_done`、`task_blocked`、`task_failed`、`attention_opened`、`attention_answered`、
`quota_exhausted`、`leader_reply`。

## 8. Leader

`leader.ts` 持有一個長駐的無頭 Claude 對話（session id 存 `kv`）：

- 每則輸入用 `claude -p --resume <id>`（第一次用 `--session-id`）精簡啟動：`--safe-mode --strict-mcp-config
  --mcp-config '{"mcpServers":{}}' --tools Bash`，並以 `--allowedTools` 只放行 `team` 指令。模型取角色 `leader`。
- 輸入來源：人的訊息（看板、MCP、CLI、Grok）與服務端彙整的事件批次（任務完成、阻塞、待決事項被回答）。
  序列處理，一次一則。事件批次要合併，不要每個事件叫一次模型。
- `--append-system-prompt` 給 leader 的規則：你只做受理、拆解、派工、回報；不自己改程式碼；
  任務細節一律用 `team` 指令查，不要憑記憶；需要人決定的事用 `team attention open`；回覆要短。
- 每輪記錄上下文大小；超過 `service.json` 的門檻（預設 60000 token）就送一次 `/compact`。
- `team resume` 印出現況摘要（進行中的任務、未讀回執、未決事項），不經過模型，供新對話接手。

## 9. 中樞與 Grok

`hub.ts`，由 `service.json` 的 `grok.enabled` 控制，**預設關閉**（現有的中樞 session 也在監看同一個收件匣，
兩者不能同時開）。

- 進：子行程 `grokmsg watch` 逐行輸出新訊息 → `grokmsg read <id>` → 原文寫入 `messages`（channel grok，in）→ 交給 leader。
- 出：leader 對 Grok 來源訊息的回覆 → 長度超過門檻時用角色 `hub_summarizer` 整理成短訊息 → `grokmsg reply <id> --status … --text …`。
  待決事項的問題與選項不經過模型，原樣以 `--question`、`--option` 傳遞。
- 主動回報：`grokmsg notify --text …`。觸發：任務完成／失敗、待決事項、阻塞、額度用完、worker 無回執。
  同類進度在時間窗內合併；待決事項與額度用完不合併、不受安靜時段限制。
- 整理失敗時送截短的原文並加上「（未整理）」。
- 呼叫 `grokmsg` 一律用參數陣列，不經 shell 字串（金額裡的 `$` 會被 shell 展開）。

## 10. HTTP API

JSON。全部在 `/api` 下；`GET /` 回 `web/index.html`。

```
GET  /api/state                     看板快照：projects、tasks（含最近一次 run 摘要）、attention、quota、leader 狀態
GET  /api/events?since=<seq>        Server-Sent Events；每個事件一筆 data
POST /api/projects                  { name, repo_path, base_branch, checks }
POST /api/tasks                     { project, title, tier, ticket_md, owned_paths, priority?, parent_id?, queue? }
GET  /api/tasks/:id                 任務 + 所有 run + 最新回執
POST /api/tasks/:id/queue | cancel | retry | approve | reject
POST /api/tasks/:id/reassign        { role }
GET  /api/runs/:id/log?tail=<n>     執行日誌（只給人看；leader 的工具不包這個端點）
POST /api/leader/message            { text, source } → { reply }（等到 leader 回覆或逾時）
GET  /api/leader/messages?limit=
GET  /api/attention                 POST /api/attention { task_id?, question, options }
POST /api/attention/:id/answer      { answer, via }
GET  /api/resume                    現況摘要（純文字）
```

## 11. CLI 與 MCP

`team` 的每個子指令輸出都要短，預設純文字，`--json` 給機器。

```
team serve                         啟動服務（前景）
team status                        一屏現況
team project add <name> <repo> [--base main] [--check "name=cmd"]…
team task add --project P --title T --tier C --paths "a/**,b.ts" (--ticket-file F | -)  [--queue]
team task list [--status S] | show <id> | queue <id> | cancel <id> | retry <id> | reassign <id> <role>
team receipt <task_id>             只印最新回執
team watch [--since seq]           每個事件印一行，持續輸出
team ask "<text>"                  對 leader 說話，印回覆
team attention list | open --question Q --option A --option B [--task T] | answer <id> "<answer>"
team resume                        現況摘要
team doctor                        檢查 claude／codex／dsh／grokmsg 是否可用、憑證是否就緒（不顯示值）
```

`mcp.ts`：stdio MCP 伺服器，工具 `ask_leader`、`status`、`list_attention`、`answer_attention`、`task_action`，
全部轉呼叫 HTTP API。

## 12. 看板

單檔 `web/index.html`，讀 `/api/state`，訂閱 `/api/events` 即時更新。

- 頂部：leader 狀態、三家 runner 是否可用與額度、未決事項數。
- 五欄看板。卡片：標題、tier、執行者（模型別名）、耗時、用量／費用、commit、狀態。
- 點卡片展開：派工單、回執、審查發現、run 清單、日誌尾段；操作：改派、重試、停止、通過、退回。
- 待決事項區：問題 + 選項按鈕。
- 聊天框：直接對 leader（`POST /api/leader/message`），顯示最近訊息。
- 介面文字用繁體中文。淺色與深色都要能讀。

## 13. 測試

- `npm test` 全部用 `fake` runner 與暫存目錄，不呼叫任何真實模型，不碰 `~/.agent-team`。
- 必測：狀態轉換表、比較後才設定、路徑交集、回執核對的每一條拒絕路徑、越界檔案被拒、
  代 commit、審查 → 修正 → 升級、rate_limit 冷卻與改派、服務重啟後的復原、API 與 CLI 的主要路徑。
- 真實 runner 的冒煙測試另放 `test/smoke/`，預設不跑，需要 `TEAM_SMOKE=1`。

## 14. v1 不做

分支合併回主幹（任務完成後留下 `team/<task_id>` 分支，由人決定）、提交前的檔案租約 hook、
服務端主動推送喚醒桌面端、自動輪換帳號、Jev 判定關卡（設定保留、預設關閉、可以先不實作 runner）。
