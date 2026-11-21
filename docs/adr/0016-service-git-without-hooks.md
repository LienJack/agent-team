# 0016 服務端 git 不執行 repo 的 hooks，只提交核對過的檔案

狀態：採用（安全審查修正；取代先前「服務端提交照常執行 hooks」的做法，補充 spec §6 步驟 5）

**問題**：服務端的 `git add`／`commit` 在 worker 寫過的 worktree 裡以服務身分執行。repo 若把 `core.hooksPath` 指到
工作樹內（husky 的 `.husky/_`，本 repo 就是），worker 寫進去的 hook 會以服務身分執行；`post-index-change` 連
`git add` 都會觸發。另外，檢查跑完之後才多出來（或越界）的檔案原本會被一起提交。

**決定**：

- 服務端的每一個 git 指令都帶 `-c core.hooksPath=/dev/null -c core.fsmonitor=false`（`packages/git/src/exec.ts`），
  git 子行程不拿 `SSH_AUTH_SOCK`（服務從不連遠端）。這不是對使用者提交的 `--no-verify`：使用者自己的 commit 照常跑
  hooks；只是服務代 worker 提交時不執行任何 repo 提供的程式。要靠 hook 做的檢查請寫進專案的 `checks`（會在提交前、
  在沙箱內執行；ADR 0014）。
- `GitPort.commitAll` 改為 `commitFiles({ files })`：只 `git add -- <清單內仍有變更的檔案>`（literal pathspec），
  提交前確認 index 裡沒有清單外的路徑，否則丟錯不提交。
- verify 在機器檢查之後重新計算變更清單：多出任何檔案（即使在 owned_paths 內）或出現越界／symlink 指向 owned_paths
  外的檔案 → `changed_during_checks`，不提交，轉修正 run；只提交核對過的清單。
- owned_paths 核對同時解析 symlink（檔案本身或上層目錄）：指向 owned_paths 外或 worktree 外 → 越界。

**驗證**：`packages/git/src/service-commit.test.ts`（工作樹內的 hooksPath 與 `.git/hooks` 都不執行、只提交清單、
index 有清單外路徑時拒絕、git 環境沒有 agent socket、symlink 解析）；core `verify-recheck.test.ts`；
`apps/server/src/verify-real.test.ts`（真實 git + 真實檢查：檢查寫入 `docs/leak.md` → 拒收、HEAD 不動）。
