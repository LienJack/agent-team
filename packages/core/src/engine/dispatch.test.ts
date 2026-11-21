import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';

describe('§14 四種派工結果 — four dispatch outcomes', () => {
  it('accepted: onStarted moves the run to running with its pid', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ hold: true, pid: 4242 });
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(run).toMatchObject({ state: 'running', pid: 4242 });
    expect(h.get(task.id)).toMatchObject({ status: 'running', current_run_id: run.id });
    const dispatched = h.store.events.listAfter(0).find((e) => e.type === 'run.dispatched');
    expect(dispatched?.data).toEqual({ outcome: 'accepted', reason: null });
    expect(h.store.effects.list()).toEqual([]); // run.start completed once started
    h.runners.dsh.release(undefined, { error: { kind: 'crash', message: 'x' } });
    await h.engine.runUntilIdle();
  });

  it('rejected: the runner fails before starting → attempts+1 and backoff, safe to resend', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({
      start: 'rejected',
      result: { error: { kind: 'auth', message: 'not logged in' } },
    });
    const task = h.task();
    await h.engine.runUntilIdle();
    const [run] = h.store.runs.list({ task_id: task.id });
    expect(run).toMatchObject({ state: 'failed', outcome: 'error', error: 'auth: not logged in' });
    expect(h.get(task.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      retry_at: '2026-11-21T00:00:05.000Z',
      current_run_id: null,
    });
    const outcome = h.store.events.listAfter(0).find((e) => e.type === 'run.dispatched');
    expect(outcome?.data).toEqual({ outcome: 'rejected', reason: 'not logged in' });

    // after the backoff it is dispatched again
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
    expect(h.get(task.id).attempts).toBe(0);
  });

  it('rejected: a worktree failure consumes an attempt without creating a run', async () => {
    const h = createTestEngine();
    h.git.failNext('ensureWorktree');
    const task = h.task();
    await h.engine.drain();
    expect(h.store.runs.list()).toEqual([]);
    expect(h.get(task.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(h.eventTypes(task.id)).toContain('task.dispatch_failed');
  });

  it('unknown: start_unknown → run start_unknown, task blocked, attention, never resent', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ start: 'unknown' });
    const task = h.task();
    await h.engine.runUntilIdle();
    const [run] = h.store.runs.list({ task_id: task.id });
    expect(run).toMatchObject({ state: 'start_unknown' });
    const blocked = h.get(task.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked_reason).toContain(run!.id);
    const attention = h.store.attention.list({ task_id: task.id });
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      kind: 'decision',
      options: ['重試', '取消'],
      status: 'open',
    });
    expect(h.notifier.sent.map((o) => o.kind).sort()).toEqual(['attention', 'task_blocked']);

    // time passes, nothing is resent automatically
    h.clock.advance(60 * 60 * 1000);
    await h.engine.runUntilIdle();
    expect(h.runners.dsh.calls).toHaveLength(1);

    // a human retry supersedes the question and dispatches again
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.engine.retryTask(task.id);
    await h.engine.runUntilIdle();
    expect(h.store.attention.get(attention[0]!.id)?.status).toBe('superseded');
    expect(h.get(task.id).status).toBe('done');
  });

  it('deferred: no slot → no run is created and nothing is consumed', async () => {
    const h = createTestEngine();
    h.runners.dsh.defaultStep = { hold: true };
    const tasks = ['a', 'b', 'c', 'd'].map((p) => h.task({ owned_paths: [`src/${p}/`] }));
    const report = await h.engine.tick();
    expect(report.dispatched.map((d) => d.outcome)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(report.deferred).toEqual([
      { task_id: tasks[3]!.id, reason: 'role_slots', retry_at: null },
    ]);
    expect(h.store.runs.list({ task_id: tasks[3]!.id })).toEqual([]);
    expect(h.get(tasks[3]!.id)).toMatchObject({ status: 'queued', attempts: 0, version: 1 });
    await h.engine.drain();
    h.runners.dsh.defaultStep = { start: 'rejected' };
    for (const id of h.runners.dsh.held())
      h.runners.dsh.release(id, { error: { kind: 'crash', message: 'stop' } });
    h.engine.cancelTask(tasks[3]!.id);
    await h.engine.runUntilIdle();
  });

  it('deferred: every candidate model cooling down → wait for the cooldown', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ result: { error: { kind: 'rate_limit', message: '429' } } });
    const task = h.task();
    await h.engine.runUntilIdle();
    // impl_C uses only dsh models in the test config, so the task waits
    const report = await h.engine.tick();
    expect(report.deferred).toEqual([
      { task_id: task.id, reason: 'no_model', retry_at: '2026-11-21T00:15:00.000Z' },
    ]);
    expect(h.get(task.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('base drift before dispatch', () => {
  it('rebuilds a pristine worktree on the new base without consuming attempts', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ result: { error: { kind: 'crash', message: 'boom' } } });
    const task = h.task();
    await h.engine.runUntilIdle();
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    const tip = h.git.advanceBase('/repos/demo', 'main', ['src/feature/other.ts']);

    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.store.workspaces.get(ws.id)?.base_sha).toBe(tip);
    const drift = h.store.events.listAfter(0).find((e) => e.type === 'task.base_drift');
    expect(drift?.data).toMatchObject({
      action: 'rebuilt',
      new_base_sha: tip,
      files: ['src/feature/other.ts'],
    });
    expect(h.get(task.id)).toMatchObject({ status: 'done' });
  });

  it('ignores base changes outside owned_paths', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ result: { error: { kind: 'crash', message: 'boom' } } });
    const task = h.task();
    await h.engine.runUntilIdle();
    h.git.advanceBase('/repos/demo', 'main', ['docs/unrelated.md']);
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.eventTypes(task.id)).not.toContain('task.base_drift');
    expect(h.get(task.id).status).toBe('done');
  });

  it('blocks with an attention item when the worktree already has work', async () => {
    const h = createTestEngine();
    // the first run leaves edits but fails, so the worktree is not pristine
    h.runners.dsh.script(
      editing(h.git, ['src/feature/a.ts'], { result: { error: { kind: 'crash', message: 'x' } } }),
    );
    const task = h.task();
    await h.engine.runUntilIdle();
    h.git.advanceBase('/repos/demo', 'main', ['src/feature/a.ts']);
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    const t = h.get(task.id);
    expect(t.status).toBe('blocked');
    expect(t.attempts).toBe(1); // unchanged by the drift
    expect(h.runners.dsh.calls).toHaveLength(1);
    const drift = h.store.events.listAfter(0).find((e) => e.type === 'task.base_drift');
    expect(drift?.data).toMatchObject({ action: 'blocked' });
    expect(h.store.attention.list({ task_id: task.id, statuses: ['open'] })).toHaveLength(1);
  });
});
