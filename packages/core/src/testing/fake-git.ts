import {
  WorktreeIntegrityError,
  type GitPort,
  type RemoveWorktreeResult,
  type ReviewDiff,
  type WorktreeRef,
} from '../ports/git.js';

interface Commit {
  sha: string;
  files: string[];
}

interface FakeRepo {
  /** branch → commits in order; the last one is the tip. */
  branches: Map<string, Commit[]>;
}

interface FakeWorktree {
  repoPath: string;
  branch: string;
  baseSha: string;
  /** commits made in this worktree after its base */
  commits: Commit[];
  dirty: Set<string>;
}

type Method = keyof GitPort;

/**
 * In-memory GitPort. Repos are created on first use with one root commit on every branch asked
 * for. Tests simulate worker edits with `touch(worktreePath, files)` and base-branch movement
 * with `advanceBase(repoPath, branch, files)`. `failNext(method)` makes the next call throw.
 */
export class FakeGit implements GitPort {
  readonly repos = new Map<string, FakeRepo>();
  readonly worktrees = new Map<string, FakeWorktree>();
  readonly calls: Array<{ method: Method; input: unknown }> = [];
  /** worktree path → file → where it really lives (`null` = outside the worktree). */
  readonly symlinks = new Map<string, Map<string, string | null>>();
  /** Repositories on a case-insensitive filesystem. */
  readonly caseInsensitive = new Set<string>();
  /** worktree path → why it fails the identity check (`tamper()`). */
  readonly tampered = new Map<string, string>();
  private counter = 0;
  private readonly failures = new Map<Method, number>();

  /** Simulate a worker rewriting the worktree's `.git` (docs/adr/0018). */
  tamper(worktreePath: string, reason = '.git points at the primary checkout'): this {
    this.tampered.set(worktreePath, reason);
    return this;
  }

  /** The identity check every worktree git operation does first. */
  private verify(ref: WorktreeRef, baseBranch?: string): void {
    const why = this.tampered.get(ref.worktreePath);
    if (why !== undefined) throw new WorktreeIntegrityError(ref.worktreePath, why);
    const wt = this.worktrees.get(ref.worktreePath);
    if (wt && (wt.branch !== ref.branch || wt.repoPath !== ref.repoPath)) {
      throw new WorktreeIntegrityError(ref.worktreePath, `HEAD is ${wt.branch}, not ${ref.branch}`);
    }
    if (baseBranch !== undefined && ref.branch === baseBranch) {
      throw new WorktreeIntegrityError(ref.worktreePath, 'HEAD is on the base branch');
    }
  }

  private sha(): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(8, '0').padEnd(40, 'a');
  }

  private record(method: Method, input: unknown): void {
    this.calls.push({ method, input });
    const n = this.failures.get(method) ?? 0;
    if (n > 0) {
      this.failures.set(method, n - 1);
      throw new Error(`git ${method} failed (scripted)`);
    }
  }

  failNext(method: Method, times = 1): this {
    this.failures.set(method, (this.failures.get(method) ?? 0) + times);
    return this;
  }

  private repo(repoPath: string): FakeRepo {
    let repo = this.repos.get(repoPath);
    if (!repo) {
      repo = { branches: new Map() };
      this.repos.set(repoPath, repo);
    }
    return repo;
  }

  private branchCommits(repoPath: string, branch: string): Commit[] {
    const repo = this.repo(repoPath);
    let commits = repo.branches.get(branch);
    if (!commits) {
      commits = [{ sha: this.sha(), files: [] }];
      repo.branches.set(branch, commits);
    }
    return commits;
  }

  tipOf(repoPath: string, branch: string): string {
    const commits = this.branchCommits(repoPath, branch);
    return commits[commits.length - 1]!.sha;
  }

  private wt(path: string): FakeWorktree {
    const wt = this.worktrees.get(path);
    if (!wt) throw new Error(`no worktree at ${path}`);
    return wt;
  }

  private headOf(wt: FakeWorktree): string {
    return wt.commits[wt.commits.length - 1]?.sha ?? wt.baseSha;
  }

  // ------------------------------------------------------------ test helpers

  /** Simulate edits (uncommitted) in a worktree. */
  touch(worktreePath: string, files: string[]): void {
    const wt = this.wt(worktreePath);
    for (const f of files) wt.dirty.add(f);
  }

  /** Move a base branch forward with a commit touching `files`; returns the new tip. */
  advanceBase(repoPath: string, branch: string, files: string[]): string {
    const commits = this.branchCommits(repoPath, branch);
    const sha = this.sha();
    commits.push({ sha, files });
    return sha;
  }

  /** Create a worktree directory the database does not know about (orphan). */
  addStrayWorktree(repoPath: string, worktreePath: string, branch: string): void {
    this.worktrees.set(worktreePath, {
      repoPath,
      branch,
      baseSha: this.tipOf(repoPath, 'main'),
      commits: [],
      dirty: new Set(),
    });
  }

  // -------------------------------------------------------------- GitPort

  async ensureWorktree(input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
  }) {
    this.record('ensureWorktree', input);
    const existing = this.worktrees.get(input.worktreePath);
    if (existing) {
      this.verify(input);
      return { baseSha: existing.baseSha, headSha: this.headOf(existing), created: false };
    }
    const baseSha = this.tipOf(input.repoPath, input.baseBranch);
    this.worktrees.set(input.worktreePath, {
      repoPath: input.repoPath,
      branch: input.branch,
      baseSha,
      commits: [],
      dirty: new Set(),
    });
    return { baseSha, headSha: baseSha, created: true };
  }

  async removeWorktree(input: {
    repoPath: string;
    worktreePath: string;
    branch?: string;
    force?: boolean;
  }): Promise<RemoveWorktreeResult> {
    this.record('removeWorktree', input);
    const wt = this.worktrees.get(input.worktreePath);
    const why = this.tampered.get(input.worktreePath);
    if (wt && why !== undefined && input.force !== true) {
      return { removed: false, reason: 'tampered', changes: 0, detail: why };
    }
    if (wt && wt.dirty.size > 0 && input.force !== true) {
      return { removed: false, reason: 'dirty', changes: wt.dirty.size };
    }
    this.worktrees.delete(input.worktreePath);
    return { removed: true };
  }

  async resetWorktree(input: WorktreeRef & { toSha: string }): Promise<void> {
    this.record('resetWorktree', input);
    this.verify(input);
    const wt = this.wt(input.worktreePath);
    if (wt.dirty.size > 0 || wt.commits.length > 0) throw new Error('worktree is not pristine');
    wt.baseSha = input.toSha;
  }

  async status(input: WorktreeRef) {
    this.record('status', input);
    this.verify(input);
    const wt = this.wt(input.worktreePath);
    return { headSha: this.headOf(wt), clean: wt.dirty.size === 0 };
  }

  async changedFiles(input: WorktreeRef & { sinceSha: string }): Promise<string[]> {
    this.record('changedFiles', input);
    this.verify(input);
    const wt = this.wt(input.worktreePath);
    const idx = wt.commits.findIndex((c) => c.sha === input.sinceSha);
    const after = input.sinceSha === wt.baseSha ? wt.commits : wt.commits.slice(idx + 1);
    const files = new Set<string>(wt.dirty);
    for (const c of after) for (const f of c.files) files.add(f);
    return [...files].sort();
  }

  /** Commits the listed dirty files only; other dirty files stay uncommitted. */
  async commitFiles(
    input: WorktreeRef & { baseBranch: string; message: string; files: readonly string[] },
  ) {
    this.record('commitFiles', input);
    this.verify(input, input.baseBranch);
    const wt = this.wt(input.worktreePath);
    const files = [...wt.dirty].filter((f) => input.files.includes(f)).sort();
    if (files.length === 0) return { sha: this.headOf(wt), created: false };
    const commit = { sha: this.sha(), files };
    wt.commits.push(commit);
    for (const f of files) wt.dirty.delete(f);
    return { sha: commit.sha, created: true };
  }

  async rebuildWorktree(input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
  }) {
    this.record('rebuildWorktree', input);
    this.tampered.delete(input.worktreePath); // a rebuild repairs and re-creates it
    const baseSha = this.tipOf(input.repoPath, input.baseBranch);
    this.worktrees.set(input.worktreePath, {
      repoPath: input.repoPath,
      branch: input.branch,
      baseSha,
      commits: [],
      dirty: new Set(),
    });
    this.symlinks.delete(input.worktreePath);
    return { baseSha };
  }

  async resolvePaths(input: { worktreePath: string; files: readonly string[] }) {
    this.record('resolvePaths', input);
    const links = this.symlinks.get(input.worktreePath);
    const out: Record<string, string | null> = {};
    for (const f of input.files) out[f] = links?.has(f) ? links.get(f)! : f;
    return out;
  }

  async ignoresCase(input: { repoPath: string }) {
    this.record('ignoresCase', input);
    return this.caseInsensitive.has(input.repoPath);
  }

  /** Make `file` in a worktree a symlink that resolves to `target` (`null` = outside). */
  link(worktreePath: string, file: string, target: string | null): void {
    let links = this.symlinks.get(worktreePath);
    if (!links) this.symlinks.set(worktreePath, (links = new Map()));
    links.set(file, target);
  }

  /** HEAD of a worktree (tests). */
  head(worktreePath: string): string {
    return this.headOf(this.wt(worktreePath));
  }

  /** Uncommitted files of a worktree (tests). */
  dirtyFiles(worktreePath: string): string[] {
    return [...this.wt(worktreePath).dirty].sort();
  }

  /**
   * One fake section per file committed in `baseSha..headSha` (`diff --git a/f b/f` + one added
   * line), filled whole while it fits in `maxChars`, like the real port.
   */
  async reviewDiff(
    input: WorktreeRef & { baseSha: string; headSha: string; maxChars: number },
  ): Promise<ReviewDiff> {
    this.record('reviewDiff', input);
    this.verify(input);
    const wt = this.wt(input.worktreePath);
    const from =
      input.baseSha === wt.baseSha ? 0 : wt.commits.findIndex((c) => c.sha === input.baseSha) + 1;
    const to = wt.commits.findIndex((c) => c.sha === input.headSha);
    const files = [...new Set(wt.commits.slice(from, to + 1).flatMap((c) => c.files))].sort();
    const sections = files.map(
      (f) =>
        `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -0,0 +1 @@\n+${this.diffLine(f)}\n`,
    );
    let diff = '';
    const omittedFiles: string[] = [];
    sections.forEach((section, i) => {
      if (diff.length + section.length <= input.maxChars) diff += section;
      else omittedFiles.push(files[i]!);
    });
    const stat = [
      ...files.map((f) => ` ${f} | 1 +`),
      ` ${files.length} file${files.length === 1 ? '' : 's'} changed, ${files.length} insertion${files.length === 1 ? '' : 's'}(+)`,
    ].join('\n');
    return { stat, diff, truncated: omittedFiles.length > 0, omittedFiles };
  }

  /** Added line of a file's fake diff section (tests may override, e.g. to make it large). */
  diffLine: (file: string) => string = (file) => `changed ${file}`;

  async resolveRef(input: { repoPath: string; ref: string }): Promise<string> {
    this.record('resolveRef', input);
    return this.tipOf(input.repoPath, input.ref);
  }

  async diffFiles(input: { repoPath: string; fromSha: string; toSha: string }): Promise<string[]> {
    this.record('diffFiles', input);
    for (const commits of this.repo(input.repoPath).branches.values()) {
      const from = commits.findIndex((c) => c.sha === input.fromSha);
      const to = commits.findIndex((c) => c.sha === input.toSha);
      if (from >= 0 && to >= from) {
        return [...new Set(commits.slice(from + 1, to + 1).flatMap((c) => c.files))].sort();
      }
    }
    throw new Error(`cannot diff ${input.fromSha}..${input.toSha}`);
  }

  async listManagedWorktrees(input: { repoPath: string; root: string }) {
    this.record('listManagedWorktrees', input);
    return [...this.worktrees.entries()]
      .filter(
        ([path, wt]) =>
          wt.repoPath === input.repoPath &&
          path.startsWith(`${input.root}/`) &&
          wt.branch.startsWith('team/'),
      )
      .map(([worktreePath, wt]) => ({ worktreePath, branch: wt.branch }));
  }
}
