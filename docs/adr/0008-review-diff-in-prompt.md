# 0008 審查者從提示取得 diff

狀態：採用（phase 2 收尾）

**問題**：審查 run 是唯讀的（claude 只開 `Read Glob Grep`；codex／dsh 為 read-only sandbox），無法執行 `git diff`，
只能猜 base..head 改了什麼。

**決定**：

- `GitPort.reviewDiff({ worktreePath, baseSha, headSha, maxChars })` 回傳 `{ stat, diff, truncated, omittedFiles }`：
  `stat` 是完整的 `git diff --stat`；`diff` 是 `git diff --patch --find-renames --no-ext-diff --no-textconv` 依檔案切段，
  依 diff 順序整段放入，放不下的段落略過（後面較小的仍可放入），被略過的檔名列在 `omittedFiles`。只讀、可重跑。
- engine 在 `dispatchPlanned` 的交易**之前**取 diff（`createRun` 在同步交易內），上限 `REVIEW_DIFF_MAX_CHARS = 60000`；
  提示依序為：工作規則、審查範圍（base／head／owned_paths／實作者摘要、機器檢查已通過）、派工單原文、
  「驗收標準」、變更（stat + diff + 截斷說明：列出略過的檔案，請用 Read 讀現行內容）、回執 schema。
- 「驗收標準」取派工單中第一個標題含「驗收／Acceptance／完成標準／完成條件／Definition of done／Done when」的段落
  （到下一個同級或更高的標題）；沒有就寫明以派工單原文全部要求為準。不新增 task 欄位。
- 取 diff 失敗 = 派工被拒（計 attempts、退避重試）；沒有 `head_sha` 時不附 diff 並說明。

**後果**：審查者只需 Read／Glob／Grep。提示（連同 diff）存在 `run.start` effect 的 `RunSpec` 裡，單筆最多約 60k 字元。
