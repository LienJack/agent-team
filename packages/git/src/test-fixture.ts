// Shared temp-repository fixture for this package's tests (not exported from the entry point).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gitEnv } from './exec.js';
import { createGitPort, type CliGitPort } from './git-port.js';

export interface Fixture {
  dir: string;
  repo: string;
  root: string;
  env: Record<string, string>;
  port: CliGitPort;
  sh: (cwd: string, ...args: string[]) => string;
}

export function setup(rootName = 'worktrees'): Fixture {
  // os.tmpdir() on macOS is a symlinked /var path: exactly the case path identity must survive
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-git-'));
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  const extraEnv = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const env = gitEnv({
    ...extraEnv,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim();
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  const root = join(dir, rootName);
  const port = createGitPort({
    worktreeRoot: root,
    author: { name: 'agent-team', email: 'agent-team@localhost' },
    extraEnv,
    // a hostile inherited environment must not redirect git
    sourceEnv: { ...process.env, GIT_DIR: join(dir, 'nope'), GIT_WORK_TREE: join(dir, 'nope') },
  });
  return { dir, repo, root, env, port, sh };
}

export function cleanup(f: Fixture): void {
  try {
    f.sh(f.repo, 'worktree', 'prune');
    for (const b of f
      .sh(f.repo, 'branch', '--list', 'team/*', '--format=%(refname:short)')
      .split('\n')) {
      if (b) f.sh(f.repo, 'branch', '-D', b);
    }
  } catch {
    // the repo may already be gone
  }
  rmSync(f.dir, { recursive: true, force: true });
}

export async function newWorktree(f: Fixture, task = 't_000001') {
  const worktreePath = join(f.root, 'proj', task);
  const res = await f.port.ensureWorktree({
    repoPath: f.repo,
    worktreePath,
    branch: `team/${task}`,
    baseBranch: 'main',
  });
  return { worktreePath, ref: refOf(f, worktreePath), ...res };
}

/** The identity of a test worktree `<root>/proj/<task>` (branch `team/<task>`). */
export function refOf(f: Fixture, worktreePath: string) {
  return { worktreePath, repoPath: f.repo, branch: `team/${basename(worktreePath)}` };
}

/** Commit every uncommitted change of a worktree (tests; the port only commits listed files). */
export async function commitChanges(f: Fixture, worktreePath: string, message: string) {
  const ref = refOf(f, worktreePath);
  const files = await f.port.changedFiles({ ...ref, sinceSha: 'HEAD' });
  return f.port.commitFiles({ ...ref, baseBranch: 'main', message, files });
}
