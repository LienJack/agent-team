import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GitPort } from '@agent-team/core';
import { git, gitEnv, withLockRetry } from './exec.js';
import {
  parseNameOnlyZ,
  parseStatusZ,
  parseWorktreeListZ,
  statusPaths,
  type WorktreeEntry,
} from './parse.js';
import { assertAbsolute, isInside, samePath, stripSlash, toCallerForm } from './paths.js';
import { fillReviewDiff } from './review-diff.js';

export interface GitPortOptions {
  /** Every worktree this port creates or removes must be under this directory. */
  worktreeRoot: string;
  /**
   * Identity of service-side commits (`service.json` → `git.author`; default
   * `agent-team <agent-team@localhost>`).
   */
  author?: { name: string; email: string };
  /** Extra environment for git children (tests isolate the global config with it). */
  extraEnv?: Record<string, string>;
  /** Environment the allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Timeout of `git commit` (hooks may run checks); default 10 minutes. */
  commitTimeoutMs?: number;
}

/** The port plus helpers the server/doctor may use. */
export interface CliGitPort extends GitPort {
  /** Directories `<root>/<project>/<task>` that git does not know as worktrees of `repoPath`. */
  findStrayDirectories(input: {
    repoPath: string;
    root: string;
    projectDir: string;
  }): Promise<string[]>;
}

export const DEFAULT_AUTHOR = { name: 'agent-team', email: 'agent-team@localhost' } as const;
const ADD_CHUNK = 200;

export function createGitPort(opts: GitPortOptions): CliGitPort {
  assertAbsolute(opts.worktreeRoot, 'worktreeRoot');
  const root = stripSlash(opts.worktreeRoot);
  const author = opts.author ?? DEFAULT_AUTHOR;
  const baseEnv = gitEnv(opts.extraEnv ?? {}, opts.sourceEnv ?? process.env);
  const readEnv = { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' };
  const commitEnv = {
    ...baseEnv,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };

  const run = (cwd: string, args: string[], env = baseEnv, timeoutMs?: number) =>
    git(args, { cwd, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const text = async (cwd: string, args: string[], env = baseEnv) =>
    (await run(cwd, args, env)).stdout.toString('utf8').trim();

  function assertManaged(path: string): void {
    assertAbsolute(path, 'worktreePath');
    if (!isInside(path, root)) {
      throw new Error(`refusing to touch ${path}: not under the worktree root ${root}`);
    }
  }

  async function revParse(cwd: string, ref: string): Promise<string> {
    try {
      return await text(cwd, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ]);
    } catch (e) {
      throw new Error(`cannot resolve ${ref} in ${cwd}`, { cause: e });
    }
  }

  async function worktrees(repoPath: string): Promise<WorktreeEntry[]> {
    const res = await run(repoPath, ['worktree', 'list', '--porcelain', '-z'], readEnv);
    return parseWorktreeListZ(res.stdout);
  }

  const prune = (repoPath: string) => withLockRetry(() => run(repoPath, ['worktree', 'prune']));

  async function statusEntries(worktreePath: string) {
    const res = await run(
      worktreePath,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      readEnv,
    );
    return parseStatusZ(res.stdout);
  }

  async function mergeBase(repoPath: string, a: string, b: string): Promise<string> {
    return text(repoPath, ['merge-base', '--end-of-options', a, b]);
  }

  const port: CliGitPort = {
    async ensureWorktree({ repoPath, worktreePath, branch, baseBranch }) {
      assertManaged(worktreePath);
      if (!branch.startsWith('team/')) throw new Error(`refusing non-team branch ${branch}`);
      await prune(repoPath);
      const ref = `refs/heads/${branch}`;
      const list = await worktrees(repoPath);
      const here = list.find((w) => samePath(w.path, worktreePath));
      if (here) {
        if (here.branch !== ref) {
          throw new Error(
            `${worktreePath} is a worktree of ${here.branch ?? 'a detached HEAD'}, not ${branch}`,
          );
        }
        const headSha = await revParse(worktreePath, 'HEAD');
        const baseSha = await mergeBase(repoPath, ref, await revParse(repoPath, baseBranch));
        return { baseSha, headSha, created: false };
      }
      await mkdir(dirname(worktreePath), { recursive: true });
      const branchExists = await run(repoPath, ['rev-parse', '--verify', '--quiet', ref], readEnv)
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        await withLockRetry(() => run(repoPath, ['worktree', 'add', worktreePath, branch]));
        const headSha = await revParse(worktreePath, 'HEAD');
        const baseSha = await mergeBase(repoPath, ref, await revParse(repoPath, baseBranch));
        return { baseSha, headSha, created: true };
      }
      const baseSha = await revParse(repoPath, baseBranch);
      await withLockRetry(() =>
        run(repoPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseSha]),
      );
      return { baseSha, headSha: baseSha, created: true };
    },

    async removeWorktree({ repoPath, worktreePath, force }) {
      assertManaged(worktreePath);
      await prune(repoPath);
      const entry = (await worktrees(repoPath)).find((w) => samePath(w.path, worktreePath));
      if (!entry) {
        // already removed (idempotent); an empty leftover directory is cleaned up, anything else kept
        if (existsSync(worktreePath)) {
          if (readdirSync(worktreePath).length === 0) rmdirSync(worktreePath);
          else
            throw new Error(
              `${worktreePath} exists but is not a worktree of ${repoPath}; not removed`,
            );
        }
        return { removed: true };
      }
      if (existsSync(worktreePath) && force !== true) {
        const dirty = await statusEntries(worktreePath);
        if (dirty.length > 0) return { removed: false, reason: 'dirty', changes: dirty.length };
      }
      await withLockRetry(() =>
        run(repoPath, ['worktree', 'remove', ...(force === true ? ['--force'] : []), worktreePath]),
      );
      await prune(repoPath);
      return { removed: true };
    },

    async resetWorktree({ worktreePath, toSha }) {
      assertManaged(worktreePath);
      const dirty = await statusEntries(worktreePath);
      if (dirty.length > 0)
        throw new Error(`${worktreePath} has changes; cannot rebuild on a new base`);
      const target = await revParse(worktreePath, toSha);
      const head = await revParse(worktreePath, 'HEAD');
      if (head === target) return;
      const isAncestor = await run(
        worktreePath,
        ['merge-base', '--is-ancestor', '--end-of-options', head, target],
        readEnv,
      )
        .then(() => true)
        .catch(() => false);
      if (!isAncestor) {
        throw new Error(
          `${worktreePath} has commits of its own (HEAD ${head} is not in ${target})`,
        );
      }
      await withLockRetry(() => run(worktreePath, ['reset', '--hard', '--quiet', target]));
    },

    async status({ worktreePath }) {
      const headSha = await revParse(worktreePath, 'HEAD');
      const entries = await statusEntries(worktreePath);
      return { headSha, clean: entries.length === 0 };
    },

    async changedFiles({ worktreePath, sinceSha }) {
      const since = await revParse(worktreePath, sinceSha);
      const committed = await run(
        worktreePath,
        ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', since, 'HEAD'],
        readEnv,
      );
      const files = new Set(parseNameOnlyZ(committed.stdout));
      for (const p of statusPaths(await statusEntries(worktreePath))) files.add(p);
      return [...files].sort();
    },

    async commitAll({ worktreePath, message }) {
      const files = statusPaths(await statusEntries(worktreePath));
      if (files.length === 0) return { sha: await revParse(worktreePath, 'HEAD'), created: false };
      // exact paths only (literal pathspecs: a file named ":x" is not pathspec magic)
      for (let i = 0; i < files.length; i += ADD_CHUNK) {
        const chunk = files.slice(i, i + ADD_CHUNK);
        await withLockRetry(() =>
          run(worktreePath, ['--literal-pathspecs', 'add', '-A', '--', ...chunk]),
        );
      }
      const staged = await git(['diff', '--cached', '--quiet'], {
        cwd: worktreePath,
        env: baseEnv,
        okCodes: [1],
      });
      if (staged.exitCode === 0)
        return { sha: await revParse(worktreePath, 'HEAD'), created: false };
      // hooks run (never --no-verify) with stdin closed; service commits are not GPG-signed so a
      // signing prompt can never hang the service
      await withLockRetry(() =>
        run(
          worktreePath,
          ['commit', '--quiet', '--no-gpg-sign', '-m', message],
          commitEnv,
          opts.commitTimeoutMs ?? 600_000,
        ),
      );
      return { sha: await revParse(worktreePath, 'HEAD'), created: true };
    },

    async reviewDiff({ worktreePath, baseSha, headSha, maxChars }) {
      const base = await revParse(worktreePath, baseSha);
      const head = await revParse(worktreePath, headSha);
      const diffOpts = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];
      const range = ['--end-of-options', base, head];
      const stat = await text(worktreePath, ['diff', '--stat=200', ...diffOpts, ...range], readEnv);
      const names = await run(
        worktreePath,
        ['diff', '--name-only', '-z', ...diffOpts, ...range],
        readEnv,
      );
      const patch = await run(worktreePath, ['diff', '--patch', ...diffOpts, ...range], readEnv);
      return fillReviewDiff(
        stat,
        patch.stdout.toString('utf8'),
        parseNameOnlyZ(names.stdout),
        maxChars,
      );
    },

    async resolveRef({ repoPath, ref }) {
      return revParse(repoPath, ref);
    },

    async diffFiles({ repoPath, fromSha, toSha }) {
      const res = await run(
        repoPath,
        ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', fromSha, toSha],
        readEnv,
      );
      return [...new Set(parseNameOnlyZ(res.stdout))].sort();
    },

    async listManagedWorktrees({ repoPath, root: listRoot }) {
      const out: Array<{ worktreePath: string; branch: string }> = [];
      for (const w of await worktrees(repoPath)) {
        if (w.prunable || !w.branch?.startsWith('refs/heads/team/')) continue;
        const path = toCallerForm(w.path, listRoot);
        if (path !== undefined)
          out.push({ worktreePath: path, branch: w.branch.slice('refs/heads/'.length) });
      }
      return out.sort((a, b) => a.worktreePath.localeCompare(b.worktreePath));
    },

    async findStrayDirectories({ repoPath, root: scanRoot, projectDir }) {
      const base = `${stripSlash(scanRoot)}/${projectDir}`;
      if (!existsSync(base)) return [];
      const known = (await worktrees(repoPath)).map((w) => w.path);
      return readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `${base}/${d.name}`)
        .filter((p) => !known.some((k) => samePath(k, p)))
        .sort();
    },
  };
  return port;
}
