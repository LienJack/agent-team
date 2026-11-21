import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isWorktreeIntegrityError } from '@agent-team/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, newWorktree, setup, type Fixture } from './test-fixture.js';

// docs/adr/0018: a worker that rewrites `<worktree>/.git` must not get the service's git commands
// (above all the service commit) to act on the primary checkout or another worktree.

let fx: Fixture;

const integrity = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a WorktreeIntegrityError');
    },
    (err: unknown) => {
      expect(isWorktreeIntegrityError(err)).toBe(true);
      return (err as { reason: string }).reason;
    },
  );

describe('worktree identity before every service git command', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('refuses everything when .git points at the primary checkout; the base branch never moves', async () => {
    const wt = await newWorktree(fx);
    const mainBefore = fx.sh(fx.repo, 'rev-parse', 'main');
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'worker change\n');
    // the attack: git in the worktree now operates on the primary repository (HEAD = main)
    writeFileSync(join(wt.worktreePath, '.git'), `gitdir: ${join(fx.repo, '.git')}\n`);
    expect(fx.sh(wt.worktreePath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');

    const reason = await integrity(
      fx.port.commitFiles({ ...wt.ref, baseBranch: 'main', message: 'm', files: ['a.txt'] }),
    );
    expect(reason).toMatch(/git dir|git data|working tree/);
    await integrity(fx.port.status(wt.ref));
    await integrity(fx.port.changedFiles({ ...wt.ref, sinceSha: wt.baseSha }));
    await integrity(
      fx.port.reviewDiff({ ...wt.ref, baseSha: wt.baseSha, headSha: wt.baseSha, maxChars: 1000 }),
    );
    await integrity(fx.port.resetWorktree({ ...wt.ref, toSha: wt.baseSha }));
    await integrity(
      fx.port.ensureWorktree({
        repoPath: fx.repo,
        worktreePath: wt.worktreePath,
        branch: wt.ref.branch,
        baseBranch: 'main',
      }),
    );
    expect(fx.sh(fx.repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(fx.sh(fx.repo, 'status', '--porcelain')).toBe('');
    expect(fx.sh(fx.repo, 'log', '--format=%s', 'main')).toBe('init');
  });

  it("refuses a pointer to another worktree's admin dir", async () => {
    const a = await newWorktree(fx, 't_aaaaaa');
    const b = await newWorktree(fx, 't_bbbbbb');
    const bPointer = readFileSync(join(b.worktreePath, '.git'), 'utf8');
    writeFileSync(join(a.worktreePath, '.git'), bPointer);
    const reason = await integrity(fx.port.status(a.ref));
    expect(reason).toMatch(/belongs to|working tree/);
  });

  it('refuses a .git directory (a repository of its own) and a missing .git', async () => {
    const wt = await newWorktree(fx);
    rmSync(join(wt.worktreePath, '.git'));
    expect(await integrity(fx.port.status(wt.ref))).toMatch(/missing/);
    mkdirSync(join(wt.worktreePath, '.git'));
    fx.sh(wt.worktreePath, 'init', '-q', '-b', 'team/t_000001');
    expect(await integrity(fx.port.status(wt.ref))).toMatch(/regular gitdir file/);
  });

  it('refuses when HEAD is not the task branch, and never commits on the base branch', async () => {
    const wt = await newWorktree(fx);
    fx.sh(wt.worktreePath, 'checkout', '-q', '-b', 'team/other');
    expect(await integrity(fx.port.status(wt.ref))).toMatch(/not .*team\/t_000001/);
    fx.sh(wt.worktreePath, 'checkout', '-q', 'team/t_000001');
    // records that name the base branch as the task branch are refused too
    const asBase = { ...wt.ref, branch: 'team/base' };
    await integrity(
      fx.port.commitFiles({ ...asBase, baseBranch: 'team/base', message: 'm', files: [] }),
    );
  });

  it('a tampered worktree is kept by the cleanup and repaired by a rebuild', async () => {
    const wt = await newWorktree(fx);
    const mainBefore = fx.sh(fx.repo, 'rev-parse', 'main');
    writeFileSync(join(wt.worktreePath, '.git'), `gitdir: ${join(fx.repo, '.git')}\n`);
    const kept = await fx.port.removeWorktree({
      repoPath: fx.repo,
      worktreePath: wt.worktreePath,
      branch: wt.ref.branch,
    });
    expect(kept).toMatchObject({ removed: false, reason: 'tampered' });
    expect(existsSync(wt.worktreePath)).toBe(true);

    const rebuilt = await fx.port.rebuildWorktree({
      repoPath: fx.repo,
      worktreePath: wt.worktreePath,
      branch: wt.ref.branch,
      baseBranch: 'main',
    });
    expect(rebuilt.baseSha).toBe(mainBefore);
    await expect(fx.port.status(wt.ref)).resolves.toMatchObject({ clean: true });
    expect(fx.sh(fx.repo, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it("rebuilding a worktree whose .git names another worktree's admin dir leaves that one intact", async () => {
    const a = await newWorktree(fx, 't_aaaaaa');
    const b = await newWorktree(fx, 't_bbbbbb');
    const mainBefore = fx.sh(fx.repo, 'rev-parse', 'main');
    writeFileSync(join(b.worktreePath, 'wip.txt'), "b's uncommitted work\n");
    // the attack: A's pointer names B's admin dir (`git worktree repair A` would then rewrite
    // B's admin `gitdir` to A, `worktree remove A` fail and the next prune delete B's admin dir)
    writeFileSync(join(a.worktreePath, '.git'), readFileSync(join(b.worktreePath, '.git')));

    const rebuilt = await fx.port.rebuildWorktree({ ...a.ref, baseBranch: 'main' });
    expect(rebuilt.baseSha).toBe(mainBefore);
    await expect(fx.port.status(a.ref)).resolves.toMatchObject({ clean: true });
    // B: still a worktree of its own branch, its uncommitted file kept, its admin dir alive
    fx.sh(fx.repo, 'worktree', 'prune');
    await expect(fx.port.status(b.ref)).resolves.toMatchObject({ clean: false });
    expect(readFileSync(join(b.worktreePath, 'wip.txt'), 'utf8')).toBe("b's uncommitted work\n");
    expect(fx.sh(b.worktreePath, 'status', '--porcelain')).toBe('?? wip.txt');
    expect(fx.sh(b.worktreePath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/team/t_bbbbbb');
    const list = fx.sh(fx.repo, 'worktree', 'list', '--porcelain');
    expect(list).toContain(`worktree ${realpathSync(a.worktreePath)}\n`);
    expect(list).toContain(`worktree ${realpathSync(b.worktreePath)}\n`);
    expect(list).toContain('branch refs/heads/team/t_aaaaaa');
    expect(list).toContain('branch refs/heads/team/t_bbbbbb');
    expect(list).not.toContain('prunable');
    expect(fx.sh(fx.repo, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('rebuild never writes through a .git symlink planted by the worker', async () => {
    const wt = await newWorktree(fx);
    const outside = join(fx.dir, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    rmSync(join(wt.worktreePath, '.git'));
    symlinkSync(outside, join(wt.worktreePath, '.git'));
    await fx.port.rebuildWorktree({ ...wt.ref, baseBranch: 'main' });
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    await expect(fx.port.status(wt.ref)).resolves.toMatchObject({ clean: true });
  });

  it('an intact worktree passes and commits on its own branch only', async () => {
    const wt = await newWorktree(fx);
    const mainBefore = fx.sh(fx.repo, 'rev-parse', 'main');
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'ok\n');
    const c = await fx.port.commitFiles({
      ...wt.ref,
      baseBranch: 'main',
      message: 'team(t_000001): ok',
      files: ['a.txt'],
    });
    expect(c.created).toBe(true);
    expect(fx.sh(fx.repo, 'rev-parse', 'team/t_000001')).toBe(c.sha);
    expect(fx.sh(fx.repo, 'rev-parse', 'main')).toBe(mainBefore);
  });
});
