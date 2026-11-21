# 0015 復原時先終止殘留的 worker

狀態：採用（安全審查修正；補充 spec §8「啟動復原」與 ADR 0005、0010）

**問題**：服務當機（kill -9）後，worker 的行程群組（setsid，自成 session）還活著，啟動復原卻直接把任務重新排入，
第二個 worker 會進到同一個 worktree。正常關機時執行中的機器檢查也要等到它自己結束（可能十幾分鐘）。

**決定**：

- 身分 = pid + OS 回報的啟動時間（`ps -o lstart`）。runner 在 spawn **之前**同步呼叫 `hooks.onLaunching()`（engine
  立即寫 `run.launched_at`），spawn 後以 `hooks.onSpawned({ pid, pidStartedAt })` 寫 `run.pid`、`run.pid_started_at`
  （codex 在 `thread.started` 讀到 wrapper 的群組 id 時才知道 pid）。
- 復原時對每個遺留的 `starting|running` run 先判定 worker 的下場（`ProcessControl.terminateGroup`，
  `packages/runners/src/process/control.ts`）：
  - 沒有 `launched_at` → 從未 spawn（行程內 runner、派工後立刻當機）→ 照舊重新排入；
  - 有 pid：該 pid 的行程存在且啟動時間相同 → 對整個群組 SIGTERM、寬限後 SIGKILL，確認群組消失 → 重新排入；
    pid 存在但啟動時間不同 → pid 已被重用；POSIX 不會重用仍有成員的行程群組 id，所以舊群組已不在 → 不送任何訊號，
    重新排入；沒有該行程也沒有該群組 → 重新排入；
  - 無法確認（已 launch 但沒記到 pid、沒有啟動時間、群組成員還在但領頭行程已不在、終止失敗、沒有 ProcessControl）
    → run `abandoned`（錯誤 `abandoned: worker may still be running …`）、任務 `blocked`、開一筆待決事項；只有人能重試
    （ADR 0014）。絕不對無法確認身分的 pid 送訊號。
- 剛被停止（取消、退回、通過時停掉的審查）的 run 若記有 pid，且任務還沒結束，復原也做同樣的身分檢查：相符就終止群組，
  無法確認就阻塞任務並開待決事項（`blocked_reason` 以 `worker_unconfirmed:` 開頭，只有人能重試）。
- 同一個行程內也不重疊：run 的 runner 還沒 resolve（例如被停止但群組還在終止中）時，排程器不派該任務的下一個 run
  （`worker_alive`）。
- 正常關機：`Engine.shutdown()` 觸發 `shutdownController`，進行中的機器檢查收到 AbortSignal、整個群組被終止、
  verify effect 失敗但保留，下次啟動重跑；commit 之前再檢查一次，已中止就不提交。

**驗證**：core 的 `recovery-kill.test.ts`（假 ProcessControl：相同／不同啟動時間、只剩群組成員、只 launch 沒 pid、
沒有 port、停止中的 worker 擋住下一個 run、關機中止檢查）；runners 的 `hardening.test.ts`（真實行程群組：相同啟動
時間才終止、啟動時間不符不送訊號、只剩成員回報無法確認）；`apps/server/src/crash-recovery.test.ts`（真實服務行程 +
照劇本的假 claude：執行中 kill -9 服務、群組存活、重啟後舊群組被終止，`recovery.completed` 早於新 run 的建立）。

**後果**：run 多兩個欄位（`pid_started_at`、`launched_at`）；`ps` 的精度是秒，同一秒內被重用的同一 pid 理論上分不出
（機率可忽略）。Linux 也有 `ps -o lstart`，但未在本機測。
