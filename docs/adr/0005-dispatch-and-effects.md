# 0005 派工與 effect 佇列

狀態：採用（phase 1；整合收尾更新 lane 與關機兩節）

- **派工結果的判定**：`Runner.run(spec, signal, hooks)` 多一個可選的 `hooks.onStarted`。被呼叫 =
  `accepted`；未呼叫就以 `start_unknown` 結束 = `unknown`（run `start_unknown`、任務 `blocked`、開 attention、
  不重送）；未呼叫就以其他錯誤結束 = `rejected`（照一般錯誤處理，可安全重送）；槽位／模型不足 = `deferred`
  （不建 run、不寫事件、不耗額度）。
- **先落庫**：派工交易同時寫 run（`starting`）、任務轉移與 `run.start` effect。effect 在 runner 回報啟動
  （或結束）時完成；run 的結束另由完成回呼套用。重啟後殘留的 `run.start` 若其 run 已不是 `starting`
  或不是當前 run 就直接丟棄，絕不重新啟動。
- **worktree 先建再記錄**：`ensureWorktree` 在寫 workspace 紀錄之前執行；崩潰留下的目錄由復原時的
  孤兒清理（`workspace.remove` effect）移除。
- **effect 執行**：依 `seq`；同一 lane 一次一個且保序，前面的在退避中後面的也等；不同 lane 並行。lane 預設
  kind+key；`outbox.send` 用 payload 的 `lane`：Grok 回覆是 `reply:<grokmsg id>`（同一則訊息的「處理中」與最終回覆
  保序），主動通知是 `notify:<task id 或 ->`，兩者互不等待——失敗退避中的通知不會卡住回覆（沒有 `lane` 的舊 payload
  照舊以 task 分 lane）。一個 effect 結束、釋放 lane 後立刻再跑一次 `runDue`（同 lane 的下一個不必等巡檢；
  finalizer 提交時觸發的 wake 早於 lane 釋放，看不到空出的 lane）。成功時只刪「執行時的那個 generation」；失敗記
  attempts、`due`（5 秒起倍增，上限 5 分鐘）與 error；達 `effect_max_attempts` 丟棄並發 `effect.dead`，
  執行 handler 的 `onDead`（例如 verify → 任務 `blocked`、outbox → `failed`）。
- **沒有計時器**：core 只比較 `Clock.now()` 與儲存的時間。每個有變更的交易提交後會 wake 一次 tick
  （合併）；伺服器另以 `engine.tick_ms` 巡檢。復原期間暫停 wake，避免派工與孤兒掃描競爭。
- **關機**：`shutdown()` 之後不再 tick／wake，中止本行程啟動的 run（runner 終止整個行程群組後才 resolve），
  不套用它們的結果，而是把所有仍是 `starting`／`running` 的 run 標為 `abandoned`（`abandoned: service stopped`），
  任務回 `queued`（審查 run 則留在 `review`）並附復原說明、不耗 attempts——與啟動復原同一個函式
  （`abandonLiveRuns`），所以正常關機後下次啟動沒有東西要修。當機時沒有這一步，由下次的 `recover()` 補做。
  第二次 Ctrl-C 強制結束前，伺服器先對每個 live run 的 pid 群組送 SIGKILL。
- 指令的 `actor` 預設是 human（可用保留槽）；leader 透過 API 呼叫時伺服器必須明確傳 `{ kind: 'leader' }`。
- 冷卻、熔斷與額度狀態存在 `kv` 的 `runner_health:<runner>`（JSON）。熔斷：同一 runner 連續 3 次
  非限流、非取消的失敗 → 開路 `circuit_open_ms`；之後半開，一次成功即關閉，失敗立即再開。
