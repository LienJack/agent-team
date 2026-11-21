import { runnerHealthKey } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '../errors.js';
import { createTestEngine, editing } from '../testing/harness.js';
import { DRIFT_OPTIONS } from './drift.js';

/** A task whose worktree has edits when the base moves under an owned file → blocked. */
async function driftBlocked() {
  const h = createTestEngine();
  h.runners.dsh.script(
    editing(h.git, ['src/feature/a.ts'], { result: { error: { kind: 'crash', message: 'x' } } }),
  );
  const task = h.task();
  await h.engine.runUntilIdle();
  const ws = h.store.workspaces.findCurrentByTask(task.id)!;
  const tip = h.git.advanceBase('/repos/demo', 'main', ['src/feature/a.ts', 'docs/base-only.md']);
  h.clock.advance(5000);
  await h.engine.runUntilIdle();
  expect(h.get(task.id).status).toBe('blocked');
  const item = h.store.attention.list({ task_id: task.id, statuses: ['open'] })[0]!;
  expect(item.options).toEqual([...DRIFT_OPTIONS]);
  return { h, task, ws, tip, item };
}

describe('M5 base drift can be resolved', () => {
  it('a crash between the reset and saving base_sha is picked up, not blocked', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ result: { error: { kind: 'crash', message: 'boom' } } });
    const task = h.task();
    await h.engine.runUntilIdle();
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    const tip = h.git.advanceBase('/repos/demo', 'main', ['src/feature/other.ts']);
    await h.git.resetWorktree({ worktreePath: ws.path, toSha: tip }); // …then the crash
    expect(h.store.workspaces.get(ws.id)!.base_sha).not.toBe(tip);

    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.store.workspaces.get(ws.id)!.base_sha).toBe(tip);
    expect(h.get(task.id).status).toBe('done');
  });

  it('a plain retry of a drift block is refused instead of looping', async () => {
    const { h, task } = await driftBlocked();
    expect(() => h.engine.retryTask(task.id)).toThrow(ConflictError);
    expect(h.get(task.id).status).toBe('blocked');
  });

  it('answer "continue": the tip is accepted, base_sha stays the fork point, work goes on', async () => {
    const { h, task, ws, tip, item } = await driftBlocked();
    h.runners.dsh.script(editing(h.git, ['src/feature/b.ts']));
    h.engine.answerAttention(item.id, DRIFT_OPTIONS[1], 'web');
    expect(h.get(task.id).status).toBe('queued');
    expect(h.store.workspaces.get(ws.id)).toMatchObject({
      base_sha: ws.base_sha,
      accepted_base_sha: tip,
    });
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
    // base-only changes never counted as the worker's
    expect(
      h.store.runs
        .list({ task_id: task.id })
        .some((r) => /out_of_bounds/.test(r.reject_reason ?? '')),
    ).toBe(false);
  });

  it('answer "rebuild": the worktree is recreated on the tip and the task restarts fresh', async () => {
    const { h, task, ws, tip, item } = await driftBlocked();
    h.runners.dsh.script(editing(h.git, ['src/feature/c.ts']));
    h.engine.answerAttention(item.id, DRIFT_OPTIONS[0], 'cli');
    expect(h.get(task.id).status).toBe('blocked'); // until the rebuild effect ran
    await h.engine.runUntilIdle();
    expect(h.git.calls.some((c) => c.method === 'rebuildWorktree')).toBe(true);
    expect(h.store.workspaces.get(ws.id)).toMatchObject({
      base_sha: tip,
      head_sha: expect.any(String),
    });
    const runs = h.store.runs.list({ task_id: task.id });
    expect(runs.filter((r) => r.kind === 'impl')).toHaveLength(2); // a fresh impl, not a fix
    expect(h.get(task.id)).toMatchObject({ status: 'done', fix_rounds: 0 });
  });

  it('a free-text answer is refused and the item stays open', async () => {
    const { h, item } = await driftBlocked();
    expect(() => h.engine.answerAttention(item.id, 'whatever', 'web')).toThrow(ValidationError);
    expect(h.store.attention.get(item.id)!.status).toBe('open');
  });
});

describe('L9e a half-open circuit allows exactly one trial', () => {
  it('only one task dispatches to a half-open runner until the trial succeeds', async () => {
    const h = createTestEngine();
    h.store.kv.set(
      runnerHealthKey('dsh'),
      JSON.stringify({
        runner: 'dsh',
        cooldown_until: null,
        cooldown_reason: null,
        consecutive_failures: 3,
        circuit_open_until: '2026-11-20T23:59:00.000Z', // passed → half-open
        quota: null,
      }),
    );
    h.runners.dsh.defaultStep = { hold: true };
    for (const p of ['src/a/', 'src/b/', 'src/c/']) h.task({ owned_paths: [p] });
    await h.engine.drain();
    expect(h.runners.dsh.held()).toHaveLength(1);
    // glm-flash is dsh too, so nothing else may trial; once the trial succeeds the rest go
    h.runners.dsh.defaultStep = {};
    h.runners.dsh.release();
    await h.engine.runUntilIdle();
    expect(h.runners.dsh.calls.length).toBeGreaterThanOrEqual(3);
  });
});
