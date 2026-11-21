/**
 * Git operations the engine needs (spec §6, §8). Implemented in `packages/git`. Paths are
 * absolute; file lists are repo-relative POSIX paths, sorted and unique. Every method is
 * idempotent where noted, because effects may be re-executed after a crash.
 */
export interface GitPort {
  /**
   * Ensure a worktree for `branch` exists at `worktreePath`. Creates the branch from the current
   * tip of `baseBranch` when missing; reuses an existing branch/worktree otherwise. Idempotent.
   * `baseSha` is the commit the branch was created from (merge-base with baseBranch on reuse).
   */
  ensureWorktree(input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
  }): Promise<{ baseSha: string; headSha: string; created: boolean }>;

  /** Remove the worktree directory and its git metadata; never deletes the branch. Idempotent. */
  removeWorktree(input: { repoPath: string; worktreePath: string }): Promise<void>;

  /**
   * Move a pristine worktree (clean, HEAD == its base) to `toSha` (base drift rebuild).
   * Throws if the worktree has changes or commits of its own.
   */
  resetWorktree(input: { worktreePath: string; toSha: string }): Promise<void>;

  /** HEAD sha and whether there are no staged, unstaged or untracked (non-ignored) changes. */
  status(input: { worktreePath: string }): Promise<{ headSha: string; clean: boolean }>;

  /**
   * Files that differ from `sinceSha`: commits after it plus staged, unstaged and untracked
   * (non-ignored) files. Renames list both old and new paths; deletions are included.
   */
  changedFiles(input: { worktreePath: string; sinceSha: string }): Promise<string[]>;

  /**
   * Stage everything (respecting .gitignore) and commit with `message` under the service's
   * identity, without hooks that could prompt. When there is nothing to commit, returns the
   * current HEAD with `created: false` (idempotent re-run after a crash).
   */
  commitAll(input: {
    worktreePath: string;
    message: string;
  }): Promise<{ sha: string; created: boolean }>;

  /** Resolve a ref (branch name, sha) in the primary checkout to a full sha. */
  resolveRef(input: { repoPath: string; ref: string }): Promise<string>;

  /** Files changed between two commits of the repository (base drift check). */
  diffFiles(input: { repoPath: string; fromSha: string; toSha: string }): Promise<string[]>;

  /** Worktrees of `repoPath` located under `root` whose branch starts with `team/`. */
  listManagedWorktrees(input: {
    repoPath: string;
    root: string;
  }): Promise<Array<{ worktreePath: string; branch: string }>>;
}
