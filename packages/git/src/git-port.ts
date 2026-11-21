import { existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isWorktreeIntegrityError, type GitPort, type WorktreeRef } from '@agent-team/core';
import { git, gitEnv, withLockRetry } from './exec.js';
import {
  parseNameOnlyZ,
  parseStatusZ,
  parseWorktreeListZ,
  statusPaths,
  type WorktreeEntry,
} from './parse.js';
import {
  assertAbsolute,
  canonical,
  isInside,
  samePath,
  stripSlash,
  toCallerForm,
} from './paths.js';
import { verifyWorktreeIdentity } from './identity.js';
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

  /** Before any git command inside a worktree (docs/adr/0018); throws WorktreeIntegrityError. */
  const verify = (ref: WorktreeRef, baseBranch?: string) =>
    verifyWorktreeIdentity(
      { worktreePath: ref.worktreePath, repoPath: ref.repoPath, branch: ref.branch },
      { env: readEnv, ...(baseBranch === undefined ? {} : { baseBranch }) },
    );

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
        await verify({ worktreePath, repoPath, branch });
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

    async removeWorktree({ repoPath, worktreePath, branch, force }) {
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
        // a tampered worktree is left for a human: its status would describe another checkout
        try {
          await verify({ worktreePath, repoPath, branch: branch ?? entry.branch?.slice(11) ?? '' });
        } catch (err) {
          if (!isWorktreeIntegrityError(err)) throw err;
          return { removed: false, reason: 'tampered', changes: 0, detail: err.reason };
        }
        const dirty = await statusEntries(worktreePath);
        if (dirty.length > 0) return { removed: false, reason: 'dirty', changes: dirty.length };
      }
      await withLockRetry(() =>
        run(repoPath, ['worktree', 'remove', ...(force === true ? ['--force'] : []), worktreePath]),
      );
      await prune(repoPath);
      return { removed: true };
    },

    async resetWorktree({ worktreePath, repoPath, branch, toSha }) {
      assertManaged(worktreePath);
      await verify({ worktreePath, repoPath, branch });
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

    async status(ref) {
      const { worktreePath } = ref;
      await verify(ref);
      const headSha = await revParse(worktreePath, 'HEAD');
      const entries = await statusEntries(worktreePath);
      return { headSha, clean: entries.length === 0 };
    },

    async changedFiles({ sinceSha, ...ref }) {
      const { worktreePath } = ref;
      await verify(ref);
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

    async commitFiles({ message, files, baseBranch, ...ref }) {
      const { worktreePath } = ref;
      await verify(ref, baseBranch);
      const wanted = new Set(files);
      const changed = statusPaths(await statusEntries(worktreePath)).filter((f) => wanted.has(f));
      // exact paths only (literal pathspecs: a file named ":x" is not pathspec magic)
      for (let i = 0; i < changed.length; i += ADD_CHUNK) {
        const chunk = changed.slice(i, i + ADD_CHUNK);
        await withLockRetry(() =>
          run(worktreePath, ['--literal-pathspecs', 'add', '-A', '--', ...chunk]),
        );
      }
      const staged = parseNameOnlyZ(
        (await run(worktreePath, ['diff', '--cached', '--name-only', '-z', '--no-renames'])).stdout,
      );
      const extra = staged.filter((f) => !wanted.has(f));
      if (extra.length > 0) {
        throw new Error(
          `refusing to commit: the index holds unverified paths (${extra.slice(0, 10).join(', ')})`,
        );
      }
      if (staged.length === 0) {
        return { sha: await revParse(worktreePath, 'HEAD'), created: false };
      }
      // again right before the commit: the pointer must not have changed since the add
      await verify(ref, baseBranch);
      // no hooks (SERVICE_GIT_CONFIG); not GPG-signed, so a signing prompt can never hang it
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

    async rebuildWorktree({ repoPath, worktreePath, branch, baseBranch }) {
      assertManaged(worktreePath);
      if (!branch.startsWith('team/')) throw new Error(`refusing non-team branch ${branch}`);
      const tip = await revParse(repoPath, baseBranch);
      const ref = `refs/heads/${branch}`;
      const here = (await worktrees(repoPath)).find((w) => samePath(w.path, worktreePath));
      let tampered = false;
      if (here && existsSync(worktreePath)) {
        try {
          await verify({ worktreePath, repoPath, branch });
        } catch (err) {
          if (!isWorktreeIntegrityError(err)) throw err;
          tampered = true;
        }
        if (!tampered) {
          const head = await revParse(worktreePath, 'HEAD');
          if (head === tip && (await statusEntries(worktreePath)).length === 0) {
            return { baseSha: tip };
          }
        }
      }
      const old = await run(repoPath, ['rev-parse', '--verify', '--quiet', ref], readEnv)
        .then((r) => r.stdout.toString('utf8').trim())
        .catch(() => '');
      if (old !== '' && old !== tip) {
        const archive = `refs/team-archive/${branch.slice('team/'.length)}/${old.slice(0, 12)}`;
        await run(repoPath, ['update-ref', archive, old]);
      }
      if (tampered) {
        // Never `git worktree repair` here: it follows the worker-written `.git` pointer, which
        // may name another worktree's admin dir (repair would rewrite that one to point here and
        // the prune below would delete it). The rebuild discards the directory anyway: delete it
        // (symlinks inside are unlinked, never followed) and let the prune drop its own admin
        // dir, whose `gitdir` now names a missing path (docs/adr/0018).
        await rm(worktreePath, { recursive: true, force: true });
      } else if (here) {
        await withLockRetry(() => run(repoPath, ['worktree', 'remove', '--force', worktreePath]));
      }
      await prune(repoPath);
      await mkdir(dirname(worktreePath), { recursive: true });
      await withLockRetry(() =>
        run(repoPath, ['worktree', 'add', '--no-track', '-B', branch, worktreePath, tip]),
      );
      return { baseSha: tip };
    },

    async resolvePaths({ worktreePath, files }) {
      const rootCanon = stripSlash(canonical(worktreePath));
      const out: Record<string, string | null> = {};
      for (const file of files) {
        const abs = join(worktreePath, file);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue; // deleted
        }
        let target: string;
        if (st.isSymbolicLink()) {
          // resolve the link (even a dangling one) from its real parent directory
          const parent = canonical(dirname(abs));
          target = canonical(resolve(parent, readlinkSync(abs)));
        } else {
          target = canonical(abs);
        }
        const rel = relative(rootCanon, target);
        out[file] =
          rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)
            ? null
            : rel.split(sep).join('/');
      }
      return out;
    },

    async ignoresCase({ repoPath }) {
      const res = await git(['config', '--type=bool', '--get', 'core.ignorecase'], {
        cwd: repoPath,
        env: readEnv,
        okCodes: [1],
      });
      return res.stdout.toString('utf8').trim() === 'true';
    },

    async reviewDiff({ baseSha, headSha, maxChars, ...ref }) {
      const { worktreePath } = ref;
      await verify(ref);
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
