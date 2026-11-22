# @agent-team/runners

Runner 實作（spec §7）：`claude`（`claude -p` stream-json）、`codex`（`@openai/codex-sdk` 0.171.0 與它自帶的執行檔）、
`dsh`（`dsh --profile headless --json -`）、行程內假 runner；共用子行程工具（`src/process/`：參數陣列、標準輸入關閉、
自成行程群組、逾時／取消時整群 SIGTERM→SIGKILL、結束訊號與行程結束先到者為準、逐行遮蔽金鑰後寫 `events.jsonl`／
`stderr.log`／`prompt.md`）；`CheckExecutor`。

對外介面：`createRunnerRegistry({ env, logger?, fake?, commands?, sandbox? })`（`probeAll()` 後 `capabilities()` 才有值；
`fake: true` 在 claude/codex/dsh/fake 四個名稱下各放一個可排劇本的 `InProcessFakeRunner`，用 `fake(name).script(...)`）、
`createCheckExecutor({ sandbox?, allowUnsandboxed? })`、`createProcessControl()`（復原時依 pid + 啟動時間終止殘留群組，ADR 0015）、
`@agent-team/runners/testing`（照劇本的假 CLI `fakeCliCommand`／`writeScenario`／`lastRecord`）。

- 子行程環境一律白名單（不繼承 `GIT_*`、`CLAUDECODE`、`ANTHROPIC_*`、任何金鑰）；dsh 只多拿 `OPENROUTER_API_KEY`。
- 沙箱（ADR 0014、0019）：claude 每個 run 帶 `--restricted --settings <src/claude/sandbox.ts 的設定>`；codex 用權限設定檔
  （`src/codex/sandbox.ts`，不傳 `--sandbox`）；dsh 整個行程與機器檢查以 `sandbox-exec` 執行（`src/dsh/sandbox.ts`、
  `src/checks/sandbox.ts`）。沒有 `sandbox-exec` 時 dsh 不可用、檢查不執行（`refused`），除非 `allowUnsandboxed`。
  拒絕清單在 `src/sandbox-policy.ts`（服務傳入的 DATA／`.env` + 家目錄下的憑證目錄 + repo／worktree 的 `.env`）。
- 調研 run（`RunSpec.web`，spec §17、ADR 0021）：probe 的 `supports.webSearch` 宣告能不能跑。claude 只給
  `--tools WebSearch,WebFetch`（`src/claude/sandbox.ts` 的 `claudeResearchSettings`）；codex 關掉 shell 等工具功能、
  `web_search="live"`、設定檔拒讀整個檔案系統（`src/codex/sandbox.ts`；仍會提供 `apply_patch` 與 collaboration 工具，
  靠設定檔限制）；dsh 沒有此能力，收到就拒絕。
- runner 在 spawn 前呼叫 `hooks.onLaunching`、之後以 `hooks.onSpawned` 回報 pid 與 `ps -o lstart` 啟動時間。
- codex 經 `codexPathOverride` 走 `src/codex/group-wrapper.ts`，讓 codex 自成行程群組，取消時能整群終止；
  wrapper 也在 `exec` 後插入 `--ignore-user-config --ignore-rules`（必要旗標，probe 找不到 → 不可用）與權限設定檔，
  做不到就不啟動 codex（exit 126），並關掉技能清單（ADR 0011）。
- `hooks.onStarted` 在第一個 agent 事件時呼叫；在那之前結束且無法證明沒開始工作 → `start_unknown`（ADR 0010）。
- dsh 的模型、`approval: never`、沙箱模式（Seatbelt 內為 `danger-full-access`，因為 dsh 自己的沙箱無法巢狀；沒有
  Seatbelt 時可寫 run 為 `workspace-write`、唯讀 run 為 `read-only`）與 session／storage 的根（run 的 `dsh-state/`）寫在
  run 日誌目錄的 `dsh.patch.yml`，以 `--patch` 套用。
- 檢查指令能拆成參數陣列就不經 shell；含 `&&`、`|`、`$`、萬用字元等才用 `/bin/sh -c`（理由見 `src/checks/argv.ts`）。
- 冒煙測試：`TEAM_SMOKE=1 pnpm --filter @agent-team/runners test:smoke`（會花真實額度；`SMOKE_ONLY=claude|codex|dsh`）。
