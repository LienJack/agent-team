import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from './exec.js';
import { cleanup, newWorktree, setup, type Fixture } from './test-fixture.js';

let fx: Fixture;

function hook(dir: string, name: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ${name} >> "${marker}"\n`);
  chmodSync(path, 0o755);
}

describe('H1/H3 service-side git: exact files, no repository hooks, no agent', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('never runs hooks, not even ones a worker wrote into a hooksPath inside the worktree', async () => {
    // husky-style: core.hooksPath points into the working tree, which the worker can write
    fx.sh(fx.repo, 'config', 'core.hooksPath', '.husky/_');
    const marker = join(fx.dir, 'hooks-ran');
    hook(join(fx.repo, '.git', 'hooks'), 'pre-commit', marker);
    const wt = await newWorktree(fx);
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'post-index-change']) {
      hook(join(wt.worktreePath, '.husky', '_'), name, marker);
    }
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a2\n');
    const c = await fx.port.commitFiles({
      worktreePath: wt.worktreePath,
      message: 'team(t_000001): x',
      files: ['a.txt'],
    });
    expect(c.created).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('commits only the listed files; other changes stay uncommitted', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a2\n');
    writeFileSync(join(wt.worktreePath, 'extra.txt'), 'x\n');
    const c = await fx.port.commitFiles({
      worktreePath: wt.worktreePath,
      message: 'm',
      files: ['a.txt', 'gone.txt'],
    });
    expect(fx.sh(wt.worktreePath, 'show', '--name-only', '--format=', c.sha)).toBe('a.txt');
    expect(fx.sh(wt.worktreePath, 'status', '--porcelain')).toBe('?? extra.txt');
  });

  it('refuses to commit when the index already holds a path outside the list', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a2\n');
    writeFileSync(join(wt.worktreePath, 'sneaky.txt'), 's\n');
    fx.sh(wt.worktreePath, 'add', 'sneaky.txt'); // staged by the worker
    const head = fx.sh(wt.worktreePath, 'rev-parse', 'HEAD');
    await expect(
      fx.port.commitFiles({ worktreePath: wt.worktreePath, message: 'm', files: ['a.txt'] }),
    ).rejects.toThrow(/sneaky\.txt/);
    expect(fx.sh(wt.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('git children get no SSH agent socket', () => {
    const env = gitEnv({}, { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', HOME: '/h' });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('M5 rebuild and accepted base', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('rebuildWorktree discards changes and commits, recreates on the tip, archives the old head', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'mine\n');
    await fx.port.commitFiles({ worktreePath: wt.worktreePath, message: 'own', files: ['a.txt'] });
    const oldHead = fx.sh(wt.worktreePath, 'rev-parse', 'HEAD');
    writeFileSync(join(wt.worktreePath, 'b.txt'), 'dirty\n');
    writeFileSync(join(fx.repo, 'a.txt'), 'moved\n');
    fx.sh(fx.repo, 'commit', '-q', '-am', 'move base');
    const tip = fx.sh(fx.repo, 'rev-parse', 'main');

    const res = await fx.port.rebuildWorktree({
      repoPath: fx.repo,
      worktreePath: wt.worktreePath,
      branch: 'team/t_000001',
      baseBranch: 'main',
    });
    expect(res.baseSha).toBe(tip);
    expect(await fx.port.status({ worktreePath: wt.worktreePath })).toEqual({
      headSha: tip,
      clean: true,
    });
    expect(fx.sh(fx.repo, 'for-each-ref', '--format=%(objectname)', 'refs/team-archive/')).toBe(
      oldHead,
    );
    // idempotent
    const again = await fx.port.rebuildWorktree({
      repoPath: fx.repo,
      worktreePath: wt.worktreePath,
      branch: 'team/t_000001',
      baseBranch: 'main',
    });
    expect(again.baseSha).toBe(tip);
  });

  it('keeping base_sha as the fork point: base-only changes never look like the worker’s', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'worker\n');
    // the base moves: one file the task owns (a.txt) and one it does not (b.txt)
    writeFileSync(join(fx.repo, 'a.txt'), 'base\n');
    writeFileSync(join(fx.repo, 'b.txt'), 'base\n');
    fx.sh(fx.repo, 'commit', '-q', '-am', 'move base');
    const tip = fx.sh(fx.repo, 'rev-parse', 'main');
    const fromFork = await fx.port.changedFiles({
      worktreePath: wt.worktreePath,
      sinceSha: wt.baseSha,
    });
    expect(fromFork).toEqual(['a.txt']); // what verification sees after "continue"
    const fromTip = await fx.port.changedFiles({ worktreePath: wt.worktreePath, sinceSha: tip });
    expect(fromTip).toContain('b.txt'); // why base_sha must not simply be set to the tip
  });
});

describe('M7 resolvePaths and ignoresCase', () => {
  beforeEach(() => {
    fx = setup();
  });
  afterEach(() => cleanup(fx));

  it('resolves symlinked files and directories, null outside the worktree', async () => {
    const wt = await newWorktree(fx);
    const p = wt.worktreePath;
    mkdirSync(join(p, 'src', 'feature'), { recursive: true });
    mkdirSync(join(p, 'config'));
    writeFileSync(join(p, 'config', 'secret.json'), '{}\n');
    symlinkSync('../../config/secret.json', join(p, 'src', 'feature', 'link'));
    symlinkSync(join(fx.dir), join(p, 'src', 'feature', 'out'));
    symlinkSync('../config', join(p, 'src', 'cfg'));
    writeFileSync(join(p, 'src', 'feature', 'plain.ts'), 'x\n');
    const res = await fx.port.resolvePaths({
      worktreePath: p,
      files: [
        'src/feature/link',
        'src/feature/out',
        'src/cfg/secret.json',
        'src/feature/plain.ts',
        'gone.ts',
      ],
    });
    expect(res).toEqual({
      'src/feature/link': 'config/secret.json',
      'src/feature/out': null,
      'src/cfg/secret.json': 'config/secret.json',
      'src/feature/plain.ts': 'src/feature/plain.ts',
    });
  });

  it('reads core.ignorecase of the repository', async () => {
    fx.sh(fx.repo, 'config', 'core.ignorecase', 'true');
    expect(await fx.port.ignoresCase({ repoPath: fx.repo })).toBe(true);
    fx.sh(fx.repo, 'config', 'core.ignorecase', 'false');
    expect(await fx.port.ignoresCase({ repoPath: fx.repo })).toBe(false);
  });
});
