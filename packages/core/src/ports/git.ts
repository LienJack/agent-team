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

  /**
   * Remove the worktree directory and its git metadata; never deletes the branch. Idempotent (an
   * already removed worktree is `removed: true`). Without `force`, a worktree with uncommitted or
   * untracked (non-ignored) changes is left in place and reported as `dirty`; with `force` it is
   * removed anyway (orphans with no database record, docs/adr/0009).
   */
  removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    force?: boolean;
  }): Promise<RemoveWorktreeResult>;

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

  /**
   * The change under review (docs/adr/0008): `git diff --stat` and the unified diff of
   * `baseSha..headSha`, run in the worktree. The diff holds whole per-file sections in diff order
   * while they fit in `maxChars`; sections that do not fit are left out and listed in
   * `omittedFiles`. `stat` is always complete. Read-only.
   */
  reviewDiff(input: {
    worktreePath: string;
    baseSha: string;
    headSha: string;
    maxChars: number;
  }): Promise<ReviewDiff>;

  /** Files changed between two commits of the repository (base drift check). */
  diffFiles(input: { repoPath: string; fromSha: string; toSha: string }): Promise<string[]>;

  /** Worktrees of `repoPath` located under `root` whose branch starts with `team/`. */
  listManagedWorktrees(input: {
    repoPath: string;
    root: string;
  }): Promise<Array<{ worktreePath: string; branch: string }>>;
}

export type RemoveWorktreeResult =
  | { removed: true }
  /** Not forced and the worktree has `changes` uncommitted/untracked paths: nothing was removed. */
  | { removed: false; reason: 'dirty'; changes: number };

export interface ReviewDiff {
  /** `git diff --stat` summary of the whole change (never truncated). */
  stat: string;
  /** Unified diff (`diff --git …` sections), possibly without the sections in `omittedFiles`. */
  diff: string;
  /** Whether any section was left out. */
  truncated: boolean;
  /** Repo-relative paths whose diff section was left out (diff order). */
  omittedFiles: string[];
}
