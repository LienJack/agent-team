# 0025 修正上限用完：開待決事項問人，回答後帶著指示、重新給修正額度

狀態：採用（2026-11-22；改寫 spec §6「無處可升則 `blocked`」）

**背景**：learn-anything 的 MVP1-1（tier A，`impl_A` 沒有 `escalate_to`）兩次都在「已達修正上限（2 輪）且無處可升級：
review_needs_changes」停下。每輪模型審查都會提出新的 must_fix，修正不收斂；任務 `blocked` 時只送一則
`task_blocked` 通知，沒有待決事項，人只能按重試。重試又不會重設 `fix_rounds`，所以只多一輪修正，下一次
`needs_changes` 就再被擋下。

**決定**：

1. 修正輪用完、而且沒有可升級的角色時，任務照舊 `blocked`（`blocked_reason` 開頭是「已達修正上限」），同時開一筆
   待決事項：`kind=decision`、`topic=fix_limit`（風險 normal，Grok 也能回答）、沒有選項。問題寫明卡在哪裡、回答會
   怎樣，並附上最後一輪要修的項目（最多 1500 字）。
2. 人回答後，回答會交給下一個 worker（跟 worker 的 `needs_leader` 問題一樣，ADR 0017），任務重新排隊，
   `fix_rounds` 歸零，也就是重新給 `max_fix_rounds_before_escalate` 輪修正額度。回答可以寫「哪些可以不管」、
   「先修什麼」或「接受目前做法」。
   回答 `fix_limit` 這一筆就會重排，不必等同一任務的其他待決事項：worker 在成功的 run 回執 `needs_leader` 裡留的
   說明也會開成 `worker_question`，以前它們沒回答就擋住重排（2026-11-22 MVP1-1 實際發生）。任務離開 `blocked` 時，
   這些沒回答的項目照既有規則變成 `superseded`。
3. 人直接按重試（不回答）也一樣重新給額度；這時那筆待決事項會照既有規則變成 `superseded`。Leader 的重試不重設
   額度：要再給額度是人的決定。
4. 要放棄就取消任務，不另外做「放棄」選項。

**不做的**：「有機器檢查時以檢查結果為準、略過模型審查」。機器檢查只證明測試通過，看不出設計和範圍的問題；
`rules.machine_checks_before_model_review` 已經讓模型審查只在檢查通過後才跑。不收斂的情況交給人用上面的回答處理。

**取捨**：`blocked` 時會先後送出 `task_blocked` 和待決事項兩則通知，通知量多一點；換來人可以直接回答，不必先查原因
再去按重試。
