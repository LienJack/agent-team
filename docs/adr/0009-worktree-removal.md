# 0009 worktree 移除與 `kept`

狀態：採用（phase 2 收尾）

**決定**：

- `GitPort.removeWorktree({ repoPath, worktreePath, force? })` 回傳 `{ removed: true }` 或
  `{ removed: false, reason: 'dirty', changes }`；有未提交／未追蹤（非 ignore）的變更且沒有 `force` 時**不刪、不丟錯**。
  已不存在 = `removed: true`（可重跑）。分支永遠保留。git 本身的錯誤仍丟出（effect 退避重試）。
- `workspace.remove` effect：
  - 孤兒（資料庫沒有紀錄，啟動復原時找到的 `team/*` worktree）→ `force: true`，沒有任何東西指向它；
  - 有紀錄的 workspace（定時清理）→ 從不 force；髒的話 workspace 轉 `kept`、寫 `workspace.kept` 事件、開**一筆**
    attention（decision），effect 視為完成，不再重試。
- 狀態語意：`active` = 服務端管理中（任務完成或取消後仍是 `active`，直到清理移除）；`kept` = 刻意保留、不會被自動清理
  （由人處理）；`removed` = 已移除。原本「任務完成就標 `kept`」的做法取消，否則清理會對髒 worktree 無限重排。
- 清理只挑 `active` 的 workspace；復原時 `active`／`kept` 的路徑都算已知（不會被當孤兒強制刪除）。路徑以 git 的
  canonical 形式比對後再換回呼叫端寫法（macOS `/var` → `/private/var`），測試在 symlink 的暫存根目錄下驗證。

**後果**：未提交的工作不會因清理或復原而遺失；需要人判斷的只會產生一筆待決事項。
