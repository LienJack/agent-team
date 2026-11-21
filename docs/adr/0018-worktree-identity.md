# 0018 服務端 git 先核對 worktree 的身分

狀態：採用（第二輪安全審查；補充 spec §6 步驟 5、ADR 0016）

**問題**：worktree 的 `.git` 只是 worktree 裡的一個檔案（`gitdir: <repo>/.git/worktrees/<name>`）。worker（或沙箱內的
機器檢查）把它改成 `gitdir: <repo>/.git`，服務端「在 worktree 裡」執行的每個 git 指令就改對主 repo 操作——HEAD 是基底
分支，服務端代 worker 的提交會落在 `main`。實測：改寫後在 worktree 執行 `git symbolic-ref HEAD` 得到 `refs/heads/main`。

**決定**：

- 沙箱擋寫：claude worker 的 `denyWrite` 與 `Edit(//<worktree>/.git)` 規則（不在讀取拒絕：git 要讀它）；機器檢查與 dsh
  的 Seatbelt 設定檔 `(deny file-write* (literal <worktree>/.git))`；codex 的權限設定檔原本就是 `"<worktree>/.git"="read"`。
  Seatbelt 對改寫、取代、改名、刪除、symlink、以目錄取代都拒絕（`check-sandbox.test.ts`）。
- 服務端核對（`packages/git/src/identity.ts`）：GitPort 在 worktree 裡的每個操作（`status`、`changedFiles`、
  `commitFiles`、`resetWorktree`、`reviewDiff`、既有 worktree 的 `ensureWorktree`、`removeWorktree` 的髒檢查、
  `rebuildWorktree` 的捷徑）都帶 `{ worktreePath, repoPath, branch }`，先確認：`.git` 是一般檔案；主 repo 的
  `worktree list` 有它且在 `refs/heads/<branch>`；在 worktree 裡 `rev-parse --path-format=absolute` 的 common dir 是主 repo
  的、git dir 是 `<common>/worktrees/` 的直接子目錄、top level 是 worktree 本身；那個 admin dir 的 `gitdir` 指回
  `<worktree>/.git`；`symbolic-ref HEAD` 是 `refs/heads/<branch>`（`team/` 分支）。`commitFiles` 在 `git commit` 前再核對
  一次，並拒絕 HEAD 在專案基底分支上。路徑都以 realpath 比較（`/var` 與 `/private/var`）。
- 不符丟 `WorktreeIntegrityError`（core）。engine：核對中 → run 拒收（`worktree_integrity: …`）、不提交、不開修正輪、
  任務阻塞並開一筆待決事項；派工時（含審查 diff、基底漂移）→ 同樣阻塞，不消耗 attempts；清理 → worktree 保留為 `kept`
  並開待決事項；leader 不能重試這種阻塞，人修好（例如主 repo `git worktree repair`）後重試。人選「重建 worktree」時
  先 `git worktree repair` 再照常重建。派工前也核對一次，不會把第二個 worker 送進被改過的 worktree。

**驗證**：`packages/git/src/worktree-identity.test.ts`（真實暫存 repo：`.git` 指向主 repo、指向另一個 worktree 的
admin dir、換成目錄、刪除、HEAD 不在任務分支、基底分支當任務分支——全部拒絕，`main` 的 sha 與狀態不變；被改過的
worktree 清理時保留、重建時修復）；core `integrity.test.ts`（拒收、阻塞、一筆待決事項、沒有 effect 重試、leader 不能
重試、人重試仍被擋且沒有第二個 worker）。

**後果**：每個 worktree 操作多 4 個 git 子行程（約數十毫秒）。核對擋不住「worker 在自己的 worktree 裡改它可寫的東西」
——那本來就是 worker 的工作範圍，由 owned_paths 與審查把關。
