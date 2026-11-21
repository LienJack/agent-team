import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorktreeIntegrityError, type WorktreeRef } from '@agent-team/core';
import { git } from './exec.js';
import { parseWorktreeListZ } from './parse.js';
import { canonical, samePath, stripSlash } from './paths.js';

// Worktree identity (docs/adr/0018). Workers write their worktree, and `<worktree>/.git` is just a
// file in it: rewritten to `gitdir: <repo>/.git`, every service git command run "in the worktree"
// would act on the primary checkout instead — and the service commit would land on the base
// branch. Before each such command the port proves, from the trusted primary checkout and from
// the worktree itself, that the worktree is the one the records name:
//   1. `<worktree>/.git` is a regular file (not a directory, symlink or missing);
//   2. the primary checkout lists the worktree, on `refs/heads/<branch>`;
//   3. inside the worktree git resolves the common dir to the primary checkout's, the git dir to
//      a direct child of `<common>/worktrees/`, and the top level to the worktree itself;
//   4. that admin dir's `gitdir` file points back at `<worktree>/.git`;
//   5. HEAD is the symbolic ref `refs/heads/<branch>` (a `team/` branch, never the base branch).
// Any mismatch throws `WorktreeIntegrityError`; no further git command runs in that worktree.

export interface IdentityOptions {
  env: Record<string, string>;
  /** Also refuse when HEAD is on this branch (commits: never the project's base branch). */
  baseBranch?: string;
}

const text = async (cwd: string, args: string[], env: Record<string, string>, ok?: number[]) =>
  (await git(args, { cwd, env, ...(ok ? { okCodes: ok } : {}) })).stdout.toString('utf8').trim();

export async function verifyWorktreeIdentity(
  ref: WorktreeRef,
  opts: IdentityOptions,
): Promise<void> {
  const fail = (why: string): never => {
    throw new WorktreeIntegrityError(ref.worktreePath, why);
  };
  const expectedRef = `refs/heads/${ref.branch}`;
  if (!ref.branch.startsWith('team/')) fail(`branch ${ref.branch} is not a team/ branch`);
  if (opts.baseBranch !== undefined) {
    const base = opts.baseBranch.replace(/^refs\/heads\//, '');
    if (base === ref.branch) fail(`branch ${ref.branch} is the project's base branch`);
  }
  const wt = stripSlash(canonical(ref.worktreePath));

  // 1. a plain gitdir pointer file
  let isFile = false;
  try {
    isFile = lstatSync(join(ref.worktreePath, '.git')).isFile();
  } catch {
    fail('.git is missing');
  }
  if (!isFile) fail('.git is not a regular gitdir file');

  // 2. the trusted side: the primary checkout knows this worktree on this branch
  const common = stripSlash(
    canonical(
      await text(
        ref.repoPath,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        opts.env,
      ),
    ),
  );
  const listed = parseWorktreeListZ(
    (await git(['worktree', 'list', '--porcelain', '-z'], { cwd: ref.repoPath, env: opts.env }))
      .stdout,
  ).find((w) => samePath(w.path, ref.worktreePath));
  if (!listed) fail('the repository does not list it as a worktree');
  if (listed!.branch !== expectedRef) {
    fail(`the repository has it on ${listed!.branch ?? 'a detached HEAD'}, not ${expectedRef}`);
  }

  // 3. what git resolves inside the worktree
  let lines: string[] = [];
  try {
    lines = (
      await text(
        ref.worktreePath,
        ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
        opts.env,
      )
    ).split('\n');
  } catch (err) {
    fail(`git cannot resolve it: ${(err as Error).message}`);
  }
  const [gitDir, gitCommon, top] = lines.map((l) => stripSlash(canonical(l.trim())));
  if (!gitDir || !gitCommon || !top) fail('git did not report its git dir');
  if (gitCommon !== common) fail(`its git data is ${gitCommon}, not the repository's ${common}`);
  if (dirname(gitDir!) !== join(common, 'worktrees')) {
    fail(`its git dir ${gitDir} is not an admin dir under ${join(common, 'worktrees')}`);
  }
  if (top !== wt) fail(`git sees the working tree at ${top}`);

  // 4. the admin dir points back at this worktree
  let back = '';
  try {
    back = readFileSync(join(gitDir!, 'gitdir'), 'utf8').trim();
  } catch {
    fail(`${join(gitDir!, 'gitdir')} is unreadable`);
  }
  if (stripSlash(canonical(back)) !== join(wt, '.git')) {
    fail(`its admin dir ${gitDir} belongs to ${back}`);
  }

  // 5. HEAD on the task branch
  const head = await text(ref.worktreePath, ['symbolic-ref', '-q', 'HEAD'], opts.env, [1]);
  if (head !== expectedRef) fail(`HEAD is ${head || 'detached'}, not ${expectedRef}`);
  if (opts.baseBranch !== undefined) {
    const base = `refs/heads/${opts.baseBranch.replace(/^refs\/heads\//, '')}`;
    if (head === base) fail(`HEAD is on the base branch ${opts.baseBranch}`);
  }
}
