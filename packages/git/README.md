# @agent-team/git

用 git CLI 實作 core 的 `GitPort`（spec §6、§8）：worktree 建立（`worktree add --no-track -b team/<task_id>`）與移除
（有未提交變更時拒絕，除非 `force`；從不刪分支）、變更清單（`status --porcelain -z --untracked-files=all` + 提交差異，
改名兩邊都列）、代 commit（只 `add` 實際變更的檔案、服務端身分、hook 照跑、`index.lock` 重試 5 次、不 amend／不
`--no-verify`／不 push）、基底漂移（`resolveRef` + `diffFiles`）、受管 worktree 清單與孤兒目錄掃描。

對外介面：`createGitPort({ worktreeRoot, author?, dirtyRemoval?, extraEnv? })`。只碰 `worktreeRoot` 底下的路徑；
回傳的路徑保留呼叫端的寫法（macOS 的 `/var` 與 `/private/var` 不會被當成不同目錄）。子行程環境為白名單，清掉所有
`GIT_DIR`／`GIT_WORK_TREE` 之類的 `GIT_*` 變數，並設 `GIT_TERMINAL_PROMPT=0`。
