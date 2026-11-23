import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { commitListed, uncommittedPaths } from './commit.js';
import { git, gitEnv } from './exec.js';
import { DEFAULT_AUTHOR } from './git-port.js';
import { parseNameOnlyZ, parseWorktreeListZ } from './parse.js';
import { canonical, samePath, stripSlash } from './paths.js';
import { resolveWorktreePaths } from './resolve-paths.js';

// Git side of the gate (spec §19; docs/adr/0026): a worktree the service did not create (a T3
// Code delegate's, on any branch). The identity rules are those of docs/adr/0018 minus the
// `team/` branch: the path is a real directory that is not the primary checkout, `.git` is a
// plain gitdir file, git resolves it to an admin dir of the project's repository that points back
// at it, the top level is the path itself, HEAD is on a branch that is not the base branch, and
// `base_sha` is an ancestor of HEAD. Every service git command runs without hooks (exec.ts).

export interface GateGitOptions {
  /** Identity of the gate's commits (`service.json` → `git.author`). */
  author?: { name: string; email: string };
  /** Extra environment for git children (tests isolate the global config with it). */
  extraEnv?: Record<string, string>;
  /** Environment the allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Timeout of `git commit`; default 10 minutes. */
  commitTimeoutMs?: number;
}

/** A worktree that passed the identity checks. */
export interface GateWorktree {
  /** Canonical (realpath) form. */
  worktreePath: string;
  repoPath: string;
  /** Branch name without `refs/heads/`. */
  branch: string;
  headSha: string;
  /** `base_sha` resolved to a full sha. */
  baseSha: string;
}

export type GateInspection = { ok: true; worktree: GateWorktree } | { ok: false; reason: string };

export interface GateGit {
  /** The §19 step 1 checks; never throws for a worktree that fails them (`ok: false`). */
  inspect(input: {
    repoPath: string;
    worktreePath: string;
    baseBranch: string;
    baseSha: string;
  }): Promise<GateInspection>;
  /** base..HEAD ∪ uncommitted ∪ untracked and not ignored; sorted, unique. */
  changedFiles(worktree: GateWorktree): Promise<string[]>;
  /** See GitPort.resolvePaths. */
  resolvePaths(worktree: GateWorktree, files: readonly string[]): Record<string, string | null>;
  ignoresCase(repoPath: string): Promise<boolean>;
  /**
   * Commit exactly the uncommitted `files` that still have changes (no hooks, service author).
   * Inspects the worktree again first; throws when it no longer passes or HEAD moved.
   */
  commit(input: {
    worktree: GateWorktree;
    baseBranch: string;
    files: readonly string[];
    message: string;
  }): Promise<{ sha: string; created: boolean }>;
}

class Refused extends Error {}

export function createGateGit(opts: GateGitOptions = {}): GateGit {
  const author = opts.author ?? DEFAULT_AUTHOR;
  const env = gitEnv(opts.extraEnv ?? {}, opts.sourceEnv ?? process.env);
  const readEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const text = async (cwd: string, args: string[], okCodes?: number[]) =>
    (await git(args, { cwd, env: readEnv, ...(okCodes ? { okCodes } : {}) })).stdout
      .toString('utf8')
      .trim();
  const refuse = (why: string): never => {
    throw new Refused(why);
  };

  async function identify(input: {
    repoPath: string;
    worktreePath: string;
    baseBranch: string;
    baseSha: string;
  }): Promise<GateWorktree> {
    if (!isAbsolute(input.worktreePath)) refuse('worktree_path is not an absolute path');
    let wt = '';
    try {
      wt = stripSlash(realpathSync(input.worktreePath));
    } catch {
      refuse(`${input.worktreePath} does not exist`);
    }
    if (!statSync(wt).isDirectory()) refuse(`${wt} is not a directory`);
    if (samePath(wt, input.repoPath)) refuse(`${wt} is the project's primary checkout`);
    let gitFile = false;
    try {
      gitFile = lstatSync(join(wt, '.git')).isFile();
    } catch {
      refuse(`${wt} has no .git (not a git worktree)`);
    }
    if (!gitFile) refuse(`${wt}/.git is not a gitdir file (not a linked worktree)`);

    const common = stripSlash(
      canonical(
        await text(input.repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ),
    );
    let lines: string[] = [];
    try {
      lines = (
        await text(wt, [
          'rev-parse',
          '--path-format=absolute',
          '--git-dir',
          '--git-common-dir',
          '--show-toplevel',
        ])
      ).split('\n');
    } catch (err) {
      refuse(`git cannot resolve ${wt}: ${(err as Error).message}`);
    }
    const [gitDir, gitCommon, top] = lines.map((l) => stripSlash(canonical(l.trim())));
    if (!gitDir || !gitCommon || !top) refuse('git did not report its git dir');
    if (gitCommon !== common) {
      refuse(`its git data is ${gitCommon}, not the project repository's ${common}`);
    }
    if (top !== wt) refuse(`git sees the working tree at ${top}, not ${wt}`);
    if (dirname(gitDir!) !== join(common, 'worktrees')) {
      refuse(`its git dir ${gitDir} is not an admin dir under ${join(common, 'worktrees')}`);
    }
    let back = '';
    try {
      back = readFileSync(join(gitDir!, 'gitdir'), 'utf8').trim();
    } catch {
      refuse(`${join(gitDir!, 'gitdir')} is unreadable`);
    }
    if (stripSlash(canonical(back)) !== join(wt, '.git')) {
      refuse(`its admin dir ${gitDir} belongs to ${back}`);
    }
    const listed = parseWorktreeListZ(
      (await git(['worktree', 'list', '--porcelain', '-z'], { cwd: input.repoPath, env: readEnv }))
        .stdout,
    ).some((w) => samePath(w.path, wt));
    if (!listed) refuse('the project repository does not list it as a worktree');

    const headRef = await text(wt, ['symbolic-ref', '-q', 'HEAD'], [1]);
    if (!headRef.startsWith('refs/heads/')) refuse('HEAD is detached (not on a branch)');
    const branch = headRef.slice('refs/heads/'.length);
    if (branch === input.baseBranch.replace(/^refs\/heads\//, '')) {
      refuse(`HEAD is on the project's base branch ${branch}`);
    }
    const headSha = await text(wt, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const baseSha = await text(
      wt,
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${input.baseSha}^{commit}`],
      [1],
    );
    if (baseSha === '') refuse(`base_sha ${input.baseSha} is not a commit of this repository`);
    const ancestor = await git(
      ['merge-base', '--is-ancestor', '--end-of-options', baseSha, headSha],
      { cwd: wt, env: readEnv, okCodes: [1] },
    );
    if (ancestor.exitCode !== 0) refuse(`base_sha ${input.baseSha} is not an ancestor of HEAD`);
    return { worktreePath: wt, repoPath: input.repoPath, branch, headSha, baseSha };
  }

  return {
    async inspect(input) {
      try {
        return { ok: true, worktree: await identify(input) };
      } catch (err) {
        if (err instanceof Refused) return { ok: false, reason: err.message };
        throw err;
      }
    },

    async changedFiles(w) {
      const committed = await git(
        ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', w.baseSha, 'HEAD'],
        { cwd: w.worktreePath, env: readEnv },
      );
      const files = new Set(parseNameOnlyZ(committed.stdout));
      for (const p of await uncommittedPaths(w.worktreePath, env)) files.add(p);
      return [...files].sort();
    },

    resolvePaths(w, files) {
      return resolveWorktreePaths(w.worktreePath, files);
    },

    async ignoresCase(repoPath) {
      const value = await text(
        repoPath,
        ['config', '--type=bool', '--get', 'core.ignorecase'],
        [1],
      );
      return value === 'true';
    },

    async commit({ worktree, baseBranch, files, message }) {
      const again = async () => {
        const now = await identify({ ...worktree, baseBranch, baseSha: worktree.baseSha });
        if (now.branch !== worktree.branch || now.headSha !== worktree.headSha) {
          throw new Error(
            `refusing to commit: ${worktree.worktreePath} moved since it was checked`,
          );
        }
      };
      await again();
      return commitListed({
        worktreePath: worktree.worktreePath,
        files,
        message,
        env,
        commitEnv,
        timeoutMs: opts.commitTimeoutMs ?? 600_000,
        beforeCommit: again,
      });
    },
  };
}
