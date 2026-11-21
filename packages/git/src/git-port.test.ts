import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, newWorktree, setup, type Fixture } from './test-fixture.js';

let fx: Fixture;

describe('git worktree lifecycle', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('creates team/<task> from the base tip, idempotently, and lists it in the caller’s path form', async () => {
    const tip = fx.sh(fx.repo, 'rev-parse', 'main');
    const first = await newWorktree(fx);
    expect(first).toMatchObject({ baseSha: tip, headSha: tip, created: true });
    expect(fx.sh(first.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('team/t_000001');
    // --no-track: no upstream configured
    expect(() => fx.sh(first.worktreePath, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow(
      /no upstream/,
    );

    const again = await newWorktree(fx);
    expect(again).toMatchObject({ baseSha: tip, headSha: tip, created: false });

    const listed = await fx.port.listManagedWorktrees({ repoPath: fx.repo, root: fx.root });
    expect(listed).toEqual([{ worktreePath: first.worktreePath, branch: 'team/t_000001' }]);
  });

  it('reuses an existing branch (merge-base as base) when the directory is gone', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'changed\n');
    await fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'work' });
    rmSync(wt.worktreePath, { recursive: true, force: true });
    const again = await newWorktree(fx);
    expect(again.created).toBe(true);
    expect(again.baseSha).toBe(wt.baseSha);
    expect(again.headSha).not.toBe(wt.baseSha);
  });

  it('refuses paths outside the worktree root', async () => {
    await expect(
      fx.port.ensureWorktree({
        repoPath: fx.repo,
        worktreePath: join(fx.dir, 'elsewhere', 't'),
        branch: 'team/t',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/not under the worktree root/);
    await expect(
      fx.port.removeWorktree({ repoPath: fx.repo, worktreePath: fx.repo }),
    ).rejects.toThrow(/not under the worktree root/);
  });

  it('removes a clean worktree, keeps the branch, and is idempotent', async () => {
    const wt = await newWorktree(fx);
    await fx.port.removeWorktree({ repoPath: fx.repo, worktreePath: wt.worktreePath });
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(fx.sh(fx.repo, 'branch', '--list', 'team/t_000001')).toContain('team/t_000001');
    await fx.port.removeWorktree({ repoPath: fx.repo, worktreePath: wt.worktreePath });
    expect(await fx.port.listManagedWorktrees({ repoPath: fx.repo, root: fx.root })).toEqual([]);
  });

  it('removes a clean worktree that holds ignored files (e.g. node_modules)', async () => {
    const wt = await newWorktree(fx);
    mkdirSync(join(wt.worktreePath, 'ignored', 'deep'), { recursive: true });
    writeFileSync(join(wt.worktreePath, 'ignored', 'deep', 'junk.txt'), 'j\n');
    expect((await fx.port.status({ worktreePath: wt.worktreePath })).clean).toBe(true);
    await fx.port.removeWorktree({ repoPath: fx.repo, worktreePath: wt.worktreePath });
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  it('keeps a dirty worktree (reported, not thrown) unless forced', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'new.txt'), 'x\n');
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'edited\n');
    expect(
      await fx.port.removeWorktree({ repoPath: fx.repo, worktreePath: wt.worktreePath }),
    ).toEqual({ removed: false, reason: 'dirty', changes: 2 });
    expect(existsSync(join(wt.worktreePath, 'new.txt'))).toBe(true);
    expect(
      await fx.port.removeWorktree({
        repoPath: fx.repo,
        worktreePath: wt.worktreePath,
        force: true,
      }),
    ).toEqual({ removed: true });
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(fx.sh(fx.repo, 'branch', '--list', 'team/t_000001')).toContain('team/t_000001');
  });

  it('finds directories under the project dir that git does not know', async () => {
    const wt = await newWorktree(fx);
    const stray = join(fx.root, 'proj', 't_stray');
    mkdirSync(stray, { recursive: true });
    const found = await fx.port.findStrayDirectories({
      repoPath: fx.repo,
      root: fx.root,
      projectDir: 'proj',
    });
    expect(found).toEqual([stray]);
    expect(found).not.toContain(wt.worktreePath);
  });
});

describe('git change lists', () => {
  beforeEach(() => {
    fx = setup('wt root with spaces');
  });
  afterEach(() => cleanup(fx));

  it('lists modified, untracked (full paths), deleted and both sides of renames; skips ignored', async () => {
    const wt = await newWorktree(fx);
    const p = wt.worktreePath;
    writeFileSync(join(p, 'a.txt'), 'a2\n');
    rmSync(join(p, 'b.txt'));
    mkdirSync(join(p, 'new dir', 'sub'), { recursive: true });
    writeFileSync(join(p, 'new dir', 'sub', 'file with space.txt'), 'x\n');
    writeFileSync(join(p, 'ünïcode "q".txt'), 'u\n');
    mkdirSync(join(p, 'ignored'));
    writeFileSync(join(p, 'ignored', 'junk.txt'), 'j\n');
    fx.sh(p, 'mv', '.gitignore', 'renamed.gitignore');
    fx.sh(p, 'add', 'renamed.gitignore');
    writeFileSync(join(p, '.gitignore'), 'ignored/\n');

    const files = await fx.port.changedFiles({ worktreePath: p, sinceSha: wt.baseSha });
    expect(files).toEqual(
      [
        '.gitignore',
        'a.txt',
        'b.txt',
        'new dir/sub/file with space.txt',
        'renamed.gitignore',
        'ünïcode "q".txt',
      ].sort(),
    );
    expect((await fx.port.status({ worktreePath: p })).clean).toBe(false);
  });

  it('includes files of commits after sinceSha', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'c.txt'), 'c\n');
    const c1 = await fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'one' });
    writeFileSync(join(wt.worktreePath, 'd.txt'), 'd\n');
    expect(
      await fx.port.changedFiles({ worktreePath: wt.worktreePath, sinceSha: wt.baseSha }),
    ).toEqual(['c.txt', 'd.txt']);
    expect(await fx.port.changedFiles({ worktreePath: wt.worktreePath, sinceSha: c1.sha })).toEqual(
      ['d.txt'],
    );
  });
});

describe('git service commits', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('commits exactly the changed files under the service identity, idempotently, running hooks', async () => {
    const marker = join(fx.dir, 'hook-ran');
    const hook = join(fx.repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(hook, 0o755);
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a2\n');
    writeFileSync(join(wt.worktreePath, ':magic.txt'), 'm\n');
    rmSync(join(wt.worktreePath, 'b.txt'));

    const c = await fx.port.commitAll({
      worktreePath: wt.worktreePath,
      message: 'team(t_000001): x',
    });
    expect(c.created).toBe(true);
    expect(readFileSync(marker, 'utf8').trim()).toBe('ran');
    expect(fx.sh(wt.worktreePath, 'log', '-1', '--format=%an <%ae>|%cn|%s')).toBe(
      'agent-team <agent-team@localhost>|agent-team|team(t_000001): x',
    );
    expect(
      fx.sh(wt.worktreePath, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    ).toEqual([':magic.txt', 'a.txt', 'b.txt']);
    expect(await fx.port.status({ worktreePath: wt.worktreePath })).toEqual({
      headSha: c.sha,
      clean: true,
    });

    const again = await fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'again' });
    expect(again).toEqual({ sha: c.sha, created: false });
  });

  it('keeps a zh-TW commit title intact', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), '中文\n');
    await fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'team(t_000001): 中文標題' });
    expect(fx.sh(wt.worktreePath, 'log', '-1', '--format=%s')).toBe('team(t_000001): 中文標題');
  });

  it('rejects when a hook fails (hooks are never skipped)', async () => {
    const hook = join(fx.repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho nope >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a2\n');
    await expect(
      fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'x' }),
    ).rejects.toThrow(/nope/);
  });

  it('retries while index.lock is held', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a2\n');
    const gitDir = fx.sh(wt.worktreePath, 'rev-parse', '--absolute-git-dir');
    const lock = join(gitDir, 'index.lock');
    writeFileSync(lock, '');
    const timer = setTimeout(() => rmSync(lock, { force: true }), 500);
    try {
      const c = await fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'locked' });
      expect(c.created).toBe(true);
    } finally {
      clearTimeout(timer);
      rmSync(lock, { force: true });
    }
  });
});

describe('git base drift', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('detects moved base files and rebuilds a pristine worktree on the new tip', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(fx.repo, 'a.txt'), 'moved\n');
    fx.sh(fx.repo, 'commit', '-q', '-am', 'move base');
    const tip = await fx.port.resolveRef({ repoPath: fx.repo, ref: 'main' });
    expect(tip).not.toBe(wt.baseSha);
    expect(await fx.port.diffFiles({ repoPath: fx.repo, fromSha: wt.baseSha, toSha: tip })).toEqual(
      ['a.txt'],
    );

    await fx.port.resetWorktree({ worktreePath: wt.worktreePath, toSha: tip });
    expect((await fx.port.status({ worktreePath: wt.worktreePath })).headSha).toBe(tip);
  });

  it('refuses to rebuild a worktree with changes or commits of its own', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(fx.repo, 'b.txt'), 'moved\n');
    fx.sh(fx.repo, 'commit', '-q', '-am', 'move base');
    const tip = await fx.port.resolveRef({ repoPath: fx.repo, ref: 'main' });
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'dirty\n');
    await expect(
      fx.port.resetWorktree({ worktreePath: wt.worktreePath, toSha: tip }),
    ).rejects.toThrow(/changes/);
    await fx.port.commitAll({ worktreePath: wt.worktreePath, message: 'own' });
    await expect(
      fx.port.resetWorktree({ worktreePath: wt.worktreePath, toSha: tip }),
    ).rejects.toThrow(/commits of its own/);
  });

  it('rejects unknown refs', async () => {
    await expect(fx.port.resolveRef({ repoPath: fx.repo, ref: 'nope' })).rejects.toThrow(
      /cannot resolve/,
    );
    await expect(fx.port.resolveRef({ repoPath: fx.repo, ref: '--output=/tmp/x' })).rejects.toThrow(
      /cannot resolve/,
    );
  });
});
