import { git, withLockRetry } from './exec.js';
import { parseNameOnlyZ, parseStatusZ, statusPaths } from './parse.js';

// The service-side commit (spec §6 step 5, §19 step 5): stage exactly the verified paths that
// still have changes, refuse when the index holds anything else, commit without hooks (every
// service git command runs with core.hooksPath=/dev/null; docs/adr/0016) and unsigned.

const ADD_CHUNK = 200;

export interface CommitListedInput {
  worktreePath: string;
  /** The verified, repo-relative paths. */
  files: readonly string[];
  message: string;
  /** Environment for add/diff (the service's git env). */
  env: Record<string, string>;
  /** Environment for `git commit` (with the author identity). */
  commitEnv: Record<string, string>;
  timeoutMs: number;
  /** Runs right before `git commit` (identity check: the pointer must not have changed). */
  beforeCommit: () => Promise<void>;
}

async function head(worktreePath: string, env: Record<string, string>): Promise<string> {
  const res = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: worktreePath, env });
  return res.stdout.toString('utf8').trim();
}

/** Uncommitted paths (staged, unstaged, untracked and not ignored), sorted. */
export async function uncommittedPaths(
  worktreePath: string,
  env: Record<string, string>,
): Promise<string[]> {
  const res = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    { cwd: worktreePath, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } },
  );
  return statusPaths(parseStatusZ(res.stdout));
}

export async function commitListed(
  input: CommitListedInput,
): Promise<{ sha: string; created: boolean }> {
  const { worktreePath, env } = input;
  const wanted = new Set(input.files);
  const changed = (await uncommittedPaths(worktreePath, env)).filter((f) => wanted.has(f));
  // exact paths only (literal pathspecs: a file named ":x" is not pathspec magic)
  for (let i = 0; i < changed.length; i += ADD_CHUNK) {
    const chunk = changed.slice(i, i + ADD_CHUNK);
    await withLockRetry(() =>
      git(['--literal-pathspecs', 'add', '-A', '--', ...chunk], { cwd: worktreePath, env }),
    );
  }
  const staged = parseNameOnlyZ(
    (
      await git(['diff', '--cached', '--name-only', '-z', '--no-renames'], {
        cwd: worktreePath,
        env,
      })
    ).stdout,
  );
  const extra = staged.filter((f) => !wanted.has(f));
  if (extra.length > 0) {
    throw new Error(
      `refusing to commit: the index holds unverified paths (${extra.slice(0, 10).join(', ')})`,
    );
  }
  if (staged.length === 0) return { sha: await head(worktreePath, env), created: false };
  await input.beforeCommit();
  // no hooks (SERVICE_GIT_CONFIG); not GPG-signed, so a signing prompt can never hang it
  await withLockRetry(() =>
    git(['commit', '--quiet', '--no-gpg-sign', '-m', input.message], {
      cwd: worktreePath,
      env: input.commitEnv,
      timeoutMs: input.timeoutMs,
    }),
  );
  return { sha: await head(worktreePath, env), created: true };
}
