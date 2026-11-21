import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';

// docs/adr/0018 (tampered worktree) and docs/adr/0019 (checks that cannot run sandboxed): neither
// is a worker mistake, so neither becomes a fix run or a retry loop — the task is blocked for a
// human, with an attention item, and nothing is committed.

const commits = (h: ReturnType<typeof createTestEngine>) =>
  h.git.calls.filter((c) => c.method === 'commitFiles');

describe('a worktree that fails the identity check', () => {
  it('during verification: run rejected, nothing committed, task blocked with one attention item', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({
      ...editing(h.git, ['src/feature/a.ts']),
      onRun: (spec) => {
        h.git.touch(spec.cwd, ['src/feature/a.ts']);
        h.git.tamper(spec.cwd); // the worker rewrote `.git`
      },
    });
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(run.outcome).toBe('rejected');
    expect(run.reject_reason).toMatch(/^worktree_integrity:/);
    expect(commits(h)).toHaveLength(0);
    const t = h.get(task.id);
    expect(t.status).toBe('blocked');
    expect(t.blocked_reason).toMatch(/^worktree_integrity:/);
    expect(t.fix_rounds).toBe(0); // no fix run into the same worktree
    const items = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
    expect(items).toHaveLength(1);
    expect(items[0]!.question).toMatch(/身分檢查/);
    // no effect left retrying
    expect(h.store.effects.list().filter((e) => e.kind === 'run.verify')).toHaveLength(0);
  });

  it('only a human can retry it; the next dispatch checks again and blocks again', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({
      onRun: (spec) => {
        h.git.touch(spec.cwd, ['src/feature/a.ts']);
        h.git.tamper(spec.cwd);
      },
    });
    const task = h.task();
    await h.engine.drain();
    expect(h.get(task.id).status).toBe('blocked');
    expect(() => h.engine.retryTask(task.id, { kind: 'leader' })).toThrow(/identity check/);
    const attempts = h.get(task.id).attempts;
    h.engine.retryTask(task.id, { kind: 'human' });
    await h.engine.drain();
    // ensureWorktree found the same (still tampered) worktree: blocked again, no attempt used
    expect(h.get(task.id).status).toBe('blocked');
    expect(h.get(task.id).blocked_reason).toMatch(/^worktree_integrity:/);
    expect(h.get(task.id).attempts).toBeLessThanOrEqual(attempts);
    expect(h.store.runs.list({ task_id: task.id })).toHaveLength(1); // no second worker
  });

  it('every worktree git call carries the repository and the task branch', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.drain();
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    const inWorktree = h.git.calls.filter((c) =>
      ['status', 'changedFiles', 'commitFiles', 'resetWorktree', 'reviewDiff'].includes(c.method),
    );
    expect(inWorktree.length).toBeGreaterThan(0);
    for (const c of inWorktree) {
      expect(c.input).toMatchObject({ repoPath: '/repos/demo', branch: ws.branch });
    }
    expect(commits(h)[0]!.input).toMatchObject({ baseBranch: 'main' });
  });
});

describe('checks that could not run sandboxed', () => {
  it('block the task for a human instead of starting a fix run', async () => {
    const h = createTestEngine();
    h.checks.setResult('test', { passed: false, refused: 'no sandbox here' });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(run.reject_reason).toMatch(/^checks_unsandboxed/);
    expect(h.get(task.id)).toMatchObject({ status: 'blocked', fix_rounds: 0 });
    expect(h.get(task.id).blocked_reason).toContain('no sandbox here');
    expect(commits(h)).toHaveLength(0);
  });
});
