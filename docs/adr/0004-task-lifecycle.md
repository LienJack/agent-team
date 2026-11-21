# 0004 任務生命週期細節

狀態：採用（phase 1）。spec §5–§8 沒寫死的部分。

- **新增欄位**：task 加 `current_run_id`（柵欄：只有它指向的 run 能改任務）、`retry_at`（退避）、
  `fix_notes`（下一輪修正單）、`recovery_note`（下一個提示附的復原說明）、`created_at`、`updated_at`；
  run 加 `error`；attention、message、outbox、project 加時間欄位。
- **審查階段**：審查 run 進行時任務維持 `review`（不回 `running`）；`review` 且沒有 current run = 等審查。
- **拒收一律走修正**：核對步驟 1、3、4 不過（回執無效、dispatch 不符、沒有變更、越界、檢查失敗）
  與審查 `needs_changes`、人工退回，都排修正 run。`fix_rounds` 已達
  `max_fix_rounds_before_escalate` 時，下一次失敗才升級到 `escalate_to`，並重新給同樣的修正額度；
  無處可升則 `blocked`。審查 run 的回執無效則重跑審查（算 attempts），不重做實作。
- 回執 `blocked`／`failed`：run `outcome = ok`（回執有效），任務 `blocked`。
- 非當前 run 的結果只記在 run 上（`outcome = rejected`、`stale_dispatch`），不動任務。
- `attempts` 只計 runner 錯誤與派工被拒；一次沒有 runner 錯誤的 run 會把它歸零。
- **復原**：中斷的 impl/fix run → 任務回 `queued`；中斷的審查 run → 任務留在 `review` 重新審查
  （偏離 spec「任務回 queued」：已提交的工作是完好的，重做實作是浪費）。
- **重試**：`blocked`／`failed` 的任務若最後一個 run 是審查、沒有待修正、已有提交 → 回 `review`，否則 `queued`。
- 優先序：`priority` 大者先，再依建立時間。
- 進行中（佔用 owned_paths）= `running`、`verifying`、`review`。
- 機器檢查永遠在審查前執行；`rules.machine_checks_before_model_review` 目前只是保留欄位。
