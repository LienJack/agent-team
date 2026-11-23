import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateGit, type GateGit, type GateWorktree } from './gate.js';
import { cleanup, setup, type Fixture } from './test-fixture.js';

// spec §19 step 1/2/5 on real temporary repositories: identity of an outside worktree (any
// branch, not created by the service), its change list, and the hook-free commit.

let fx: Fixture;
let gate: GateGit;
let base: string;

/** A linked worktree on `branch` (as T3 Code's `isolation: worktree` makes one). */
function outside(branch = 'feature', from = 'main'): string {
  const path = join(fx.dir, 'outside', branch.replace(/\//g, '-'));
  fx.sh(fx.repo, 'worktree', 'add', '-q', '-b', branch, path, from);
  return path;
}

async function inspected(path: string, baseBranch = 'main', baseSha = base) {
  return gate.inspect({ repoPath: fx.repo, worktreePath: path, baseBranch, baseSha });
}

async function worktreeOf(path: string): Promise<GateWorktree> {
  const r = await inspected(path);
  if (!r.ok) throw new Error(r.reason);
  return r.worktree;
}

beforeEach(() => {
  fx = setup();
  base = fx.sh(fx.repo, 'rev-parse', 'HEAD');
  gate = createGateGit({
    author: { name: 'agent-team', email: 'agent-team@localhost' },
    extraEnv: { GIT_CONFIG_GLOBAL: join(fx.dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  });
});
afterEach(() => cleanup(fx));

describe('§19 gate: worktree identity', () => {
  it('accepts a linked worktree on its own branch; the path is canonical', async () => {
    const path = outside('t3/feat');
    const r = await inspected(path);
    expect(r).toEqual({
      ok: true,
      worktree: {
        worktreePath: realpathSync(path),
        repoPath: fx.repo,
        branch: 't3/feat',
        headSha: base,
        baseSha: base,
      },
    });
    // a short base sha resolves to the full one
    const short = await inspected(path, 'main', base.slice(0, 8));
    expect(short.ok && short.worktree.baseSha).toBe(base);
  });

  it('refuses the primary checkout, a relative path, a missing one and a symlink to the repo', async () => {
    const reason = async (p: string) => {
      const r = await inspected(p);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await reason(fx.repo)).toContain('primary checkout');
    expect(await reason('repo')).toContain('not an absolute path');
    expect(await reason(join(fx.dir, 'nope'))).toContain('does not exist');
    const link = join(fx.dir, 'link');
    symlinkSync(fx.repo, link);
    expect(await reason(link)).toContain('primary checkout');
  });

  it('refuses HEAD on the base branch, a detached HEAD, and a base that is not an ancestor', async () => {
    const release = outside('release');
    const onBase = await inspected(release, 'release');
    expect(onBase.ok ? '' : onBase.reason).toContain('base branch release');

    const path = outside();
    fx.sh(path, 'checkout', '-q', '--detach');
    const detached = await inspected(path);
    expect(detached.ok ? '' : detached.reason).toContain('detached');
    fx.sh(path, 'checkout', '-q', 'feature');

    writeFileSync(join(fx.repo, 'a.txt'), 'later\n');
    fx.sh(fx.repo, 'commit', '-q', '-am', 'later on main');
    const later = fx.sh(fx.repo, 'rev-parse', 'HEAD');
    const notAncestor = await inspected(path, 'main', later);
    expect(notAncestor.ok ? '' : notAncestor.reason).toContain('not an ancestor of HEAD');
    const unknown = await inspected(path, 'main', 'deadbeef');
    expect(unknown.ok ? '' : unknown.reason).toContain('not a commit');
  });

  it('refuses a clone (.git directory) and a worktree of another repository', async () => {
    const clone = join(fx.dir, 'clone');
    fx.sh(fx.dir, 'clone', '-q', fx.repo, clone);
    const c = await inspected(clone);
    expect(c.ok ? '' : c.reason).toContain('not a gitdir file');

    const other = join(fx.dir, 'other');
    mkdirSync(other);
    fx.sh(other, 'init', '-q', '-b', 'main');
    fx.sh(other, 'commit', '-q', '--allow-empty', '-m', 'o');
    const otherWt = join(fx.dir, 'other-wt');
    fx.sh(other, 'worktree', 'add', '-q', '-b', 'x', otherWt);
    const o = await inspected(otherWt, 'main', fx.sh(other, 'rev-parse', 'HEAD'));
    expect(o.ok ? '' : o.reason).toContain('not the project repository');
  });

  it('refuses a worktree whose .git pointer was rewritten to the primary .git', async () => {
    const path = outside();
    writeFileSync(join(path, '.git'), `gitdir: ${join(fx.repo, '.git')}\n`);
    const r = await inspected(path);
    expect(r.ok).toBe(false);
  });
});

describe('§19 gate: changes and commit', () => {
  it('lists committed, modified and untracked files; never ignored ones', async () => {
    const path = outside();
    writeFileSync(join(path, 'c.txt'), 'c\n');
    fx.sh(path, 'add', 'c.txt');
    fx.sh(path, 'commit', '-q', '-m', 'worker commit');
    writeFileSync(join(path, 'a.txt'), 'a2\n');
    mkdirSync(join(path, 'new', 'deep'), { recursive: true });
    writeFileSync(join(path, 'new', 'deep', 'n.txt'), 'n\n');
    mkdirSync(join(path, 'ignored'));
    writeFileSync(join(path, 'ignored', 'x.txt'), 'x\n');
    const wt = await worktreeOf(path);
    expect(await gate.changedFiles(wt)).toEqual(['a.txt', 'c.txt', 'new/deep/n.txt']);
  });

  it('commits exactly the listed files, as the service, without any hook; a rerun adds nothing', async () => {
    const path = outside();
    const marker = join(fx.dir, 'hook-ran');
    const hookDir = join(fx.repo, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'pre-commit'), `#!/bin/sh\necho x > "${marker}"\nexit 1\n`);
    chmodSync(join(hookDir, 'pre-commit'), 0o755);
    writeFileSync(join(path, 'a.txt'), 'a2\n');
    writeFileSync(join(path, 'b.txt'), 'b2\n');
    const wt = await worktreeOf(path);
    const commit = await gate.commit({
      worktree: wt,
      baseBranch: 'main',
      files: ['a.txt'],
      message: 'team(gate): feature',
    });
    expect(commit.created).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(fx.sh(path, 'show', '--name-only', '--format=%an <%ae>|%s', commit.sha)).toBe(
      'agent-team <agent-team@localhost>|team(gate): feature\n\na.txt',
    );
    expect(fx.sh(path, 'status', '--porcelain')).toBe('M b.txt');
    expect(fx.sh(fx.repo, 'rev-parse', 'main')).toBe(base); // the base branch never moves

    const again = await gate.commit({
      worktree: await worktreeOf(path),
      baseBranch: 'main',
      files: ['a.txt'],
      message: 'm',
    });
    expect(again).toEqual({ sha: commit.sha, created: false });
  });

  it('refuses to commit when HEAD moved since the inspection', async () => {
    const path = outside();
    writeFileSync(join(path, 'a.txt'), 'a2\n');
    const wt = await worktreeOf(path);
    fx.sh(path, 'commit', '-q', '--allow-empty', '-m', 'moved');
    await expect(
      gate.commit({ worktree: wt, baseBranch: 'main', files: ['a.txt'], message: 'm' }),
    ).rejects.toThrow('moved since it was checked');
  });
});
