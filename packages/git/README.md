# @agent-team/git

用 git CLI 實作 core 的 `GitPort`（spec §6、§8）：worktree 建立（`worktree add --no-track -b team/<task_id>`）與移除
（有未提交變更且沒有 `force` 時不刪，回報 `{ removed: false, reason: 'dirty' }`；從不刪分支，見 ADR 0009）、變更清單（`status --porcelain -z --untracked-files=all` + 提交差異，
改名兩邊都列）、代 commit（`commitFiles`：只 `add` 核對過的清單內仍有變更的檔案，index 有清單外路徑就拒絕；
服務端身分；不執行 repo 的 hooks——每個指令都帶 `-c core.hooksPath=/dev/null -c core.fsmonitor=false`，ADR 0016；
`index.lock` 重試 5 次、不 amend／不 push）、重建 worktree（`rebuildWorktree`，舊 head 留在 `refs/team-archive/`）、
symlink 解析（`resolvePaths`）、`core.ignorecase`（`ignoresCase`）、基底漂移（`resolveRef` + `diffFiles`）、審查用的 diff（`reviewDiff`：完整 `--stat` + 依檔案整段放入、有上限，
ADR 0008）、受管 worktree 清單與孤兒目錄掃描。

對外介面：`createGitPort({ worktreeRoot, author?, extraEnv? })`（`author` 來自 `service.json` 的 `git.author`）。只碰 `worktreeRoot` 底下的路徑；
回傳的路徑保留呼叫端的寫法（macOS 的 `/var` 與 `/private/var` 不會被當成不同目錄）。子行程環境為白名單，清掉所有
`GIT_DIR`／`GIT_WORK_TREE` 之類的 `GIT_*` 變數與 `SSH_AUTH_SOCK`，並設 `GIT_TERMINAL_PROMPT=0`。
