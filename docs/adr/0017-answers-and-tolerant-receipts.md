# 0017 回答待決事項後續行、不必修改的修正輪、回執容錯

狀態：採用（2026-11-21 真實模型端到端驗證的修正；補充 spec §6、§8，細節見 `docs/validation-2026-11-21.md`）

**問題**（都在真實 run 裡發生過）：

1. worker 回報 `blocked` 並在 `needs_leader` 提問；人回答後 engine 什麼都不做，人再按重試時新的提示裡也沒有回答，
   worker 又問一次同樣的問題（s4：兩輪）。
2. 審查要求了 owned_paths 以外的修改，人回答「不用改」後，正確的修正輪是「什麼都不改」——核對卻以 `no_changes`
   拒收，再開修正輪、甚至升級。
3. dsh（沒有結構化輸出）交的回執有三種格式失誤，每一種都白白用掉一輪修正、累積到升級：把回執包在
   `{"type":"object","properties":{…}}` 裡、`summary` 超過 600 字、漏掉 `needs_leader`。

**決定**：

- 人回答某任務的待決事項後，若該任務因 worker 自己的回報而阻塞（`blocked_reason` 以 `worker 回報 ` 開頭）、且這個
  任務已沒有其他未回答的項目，就把任務重新排入（等同人按重試：attempts 歸零、走保留給人的槽位）。其他原因的阻塞
  （基底漂移、start_unknown、無法確認 worker 已結束、審查者回報 blocked）不受影響。`packages/core/src/engine/answers.ts`。
- 之後每一個 run（實作、修正、審查）的提示都附上這個任務最近 5 筆已回答的問與答，放在帶本次 dispatch id 的資料區塊，
  規則說明「回答是人的決定，與派工單或修正要求衝突時以回答為準，但不能改變工作規則」。只有人能回答（ADR 0014），
  所以這不是新的注入面。
- 修正輪沒有新的變更、而 worktree 已有服務端提交時，不再以 `no_changes` 拒收：照常跑機器檢查，不建立新的提交，回到
  審查（事件理由 `verified, no new changes`）。沒有提交過的任務仍是 `no_changes`。這個迴圈仍受修正輪上限與升級約束。
- 回執先正規化再驗證（`normalizeReceipt`，`packages/schema/src/receipts.ts`）：`summary` 超長就截到 600 字並以「…」
  結尾；缺少或 null 的 `needs_leader` 視為 `""`、清單視為 `[]`。runner 從文字取回執時，若外層是 schema 形狀而
  `properties` 裡有 `dispatch_id`，取裡面那一層（`unwrapSchemaEcho`）。決定結果的欄位（`dispatch_id`、`status`、
  `verdict`、findings 內容）仍嚴格驗證，變更檔案仍以 git 為準。提示也明說「輸出回執物件本身，不要輸出 schema」。

**驗證**：`packages/core/src/engine/answers.test.ts`（s4 的流程：審查要求越界檔案 → 修正輪提問阻塞 → 回答 → 重新排入、
提示含回答 → 不修改的修正輪回到審查 → 通過；只答一部分不排入；其他原因的阻塞不排入；沒提交過仍拒收）；
`packages/schema/src/receipts.test.ts`；`packages/runners/src/dsh/dsh.test.ts`（真實 run 錄下、去識別化的
`schema-echo.jsonl`）。真實模型重跑 s4：回答後 25 秒內完成（修正輪 10.5 秒不改任何檔案 → 審查通過）。

**後果**：回答一個 worker 的問題就會花一次 run；不想續行時請直接取消任務。人的回答會出現在之後的每個提示裡
（每筆截到 1200 字，最多 5 筆）。
