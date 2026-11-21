import { describe, expect, it } from 'vitest';
import { implReceipt } from '../testing/fake-runner.js';
import { createTestEngine, editing } from '../testing/harness.js';

/** Runs the first impl run with `step`, then lets the fix run succeed. */
function setup() {
  const h = createTestEngine();
  const task = h.task({ owned_paths: ['src/feature/'] });
  return { h, task };
}

function firstRun(h: ReturnType<typeof createTestEngine>, taskId: string) {
  return h.store.runs.list({ task_id: taskId })[0]!;
}

describe('§14 每條拒絕路徑、越界檔案 — receipt verification', () => {
  it('step 1: a receipt that fails Zod → rejected invalid_receipt → fix run', async () => {
    const { h, task } = setup();
    h.runners.dsh.script(
      editing(h.git, ['src/feature/a.ts'], { result: { final: { status: 'done' } } }),
      {}, // the fix run answers properly (the edit from the first run is still in the worktree)
    );
    await h.engine.runUntilIdle();
    const [first, fix] = h.store.runs.list({ task_id: task.id });
    expect(first).toMatchObject({ kind: 'impl', state: 'succeeded', outcome: 'rejected' });
    expect(first!.reject_reason).toMatch(/^invalid_receipt: /);
    expect(fix).toMatchObject({ kind: 'fix', outcome: 'ok' });
    expect(h.notifier.sent.map((o) => o.kind)).toContain('no_receipt');
    const fixSpec = h.runners.dsh.calls[1]!;
    expect(fixSpec.prompt).toContain('修正要求');
    expect(fixSpec.prompt).toContain('沒有交出有效回執');
    expect(h.get(task.id)).toMatchObject({ status: 'done', fix_rounds: 1 });
  });

  it('step 1: a missing receipt (bad_output) is a runner error, not a rejection', async () => {
    const { h, task } = setup();
    h.runners.dsh.script({
      result: { error: { kind: 'bad_output', message: 'no JSON in final' } },
    });
    await h.engine.runUntilIdle();
    expect(firstRun(h, task.id)).toMatchObject({ state: 'failed', outcome: 'error' });
    expect(h.get(task.id)).toMatchObject({ status: 'queued', attempts: 1, fix_rounds: 0 });
    expect(h.notifier.sent.map((o) => o.kind)).toContain('no_receipt');
  });

  it('step 1: dispatch_id in the receipt must match the run', async () => {
    const { h, task } = setup();
    h.runners.dsh.script(
      editing(h.git, ['src/feature/a.ts'], {
        result: (spec) => ({ final: implReceipt(spec, { dispatch_id: 'd_someone_else' }) }),
      }),
    );
    h.runners.dsh.defaultStep = { start: 'rejected' };
    await h.engine.runUntilIdle();
    const run = firstRun(h, task.id);
    expect(run.outcome).toBe('rejected');
    expect(run.reject_reason).toMatch(/^dispatch_mismatch: /);
    expect(h.get(task.id).fix_rounds).toBe(1);
  });

  it('step 1: a result from a run that is no longer current is recorded on the run only', async () => {
    const { h, task } = setup();
    h.runners.dsh.script({ hold: true });
    await h.engine.drain();
    const run = firstRun(h, task.id);
    // fence the run off as if another dispatch had replaced it
    h.store.atomic((tx) => {
      const t = tx.tasks.get(task.id)!;
      tx.tasks.update(
        { ...t, current_run_id: null, status: 'blocked', blocked_reason: 'x' },
        t.version,
      );
    });
    const before = h.get(task.id);
    h.runners.dsh.release();
    await h.engine.runUntilIdle();
    expect(h.store.runs.get(run.id)).toMatchObject({
      state: 'succeeded',
      outcome: 'rejected',
      reject_reason: expect.stringMatching(/^stale_dispatch/),
    });
    expect(h.get(task.id)).toEqual(before);
  });

  it('step 2: receipt status blocked/failed → task blocked; needs_leader opens attention', async () => {
    const { h, task } = setup();
    h.runners.dsh.script({
      result: (spec) => ({
        final: implReceipt(spec, {
          status: 'blocked',
          summary: '缺少 API 金鑰設定',
          needs_leader: '要用哪個供應商？',
        }),
      }),
    });
    await h.engine.runUntilIdle();
    expect(firstRun(h, task.id)).toMatchObject({ outcome: 'ok', state: 'succeeded' });
    const t = h.get(task.id);
    expect(t.status).toBe('blocked');
    expect(t.blocked_reason).toContain('缺少 API 金鑰設定');
    const [att] = h.store.attention.list({ task_id: task.id });
    expect(att).toMatchObject({ kind: 'question', question: '要用哪個供應商？', status: 'open' });
    expect(h.checks.calls).toEqual([]);
  });

  it('step 3: no changes in the worktree → rejected no_changes', async () => {
    const { h, task } = setup();
    h.runners.dsh.script({}); // valid receipt, touches nothing
    h.runners.dsh.defaultStep = { start: 'rejected' };
    await h.engine.runUntilIdle();
    const run = firstRun(h, task.id);
    expect(run).toMatchObject({ outcome: 'rejected', reject_reason: 'no_changes' });
    expect(h.get(task.id).fix_notes).toContain('沒有任何變更');
    expect(h.git.calls.some((c) => c.method === 'commitAll')).toBe(false);
  });

  it('step 3: files outside owned_paths (per git, not the receipt) → rejected out_of_bounds', async () => {
    const { h, task } = setup();
    h.runners.dsh.script(
      editing(h.git, ['src/feature/a.ts', 'package.json'], {
        // the receipt claims only the owned file
        result: (spec) => ({ final: implReceipt(spec, { files_changed: ['src/feature/a.ts'] }) }),
      }),
    );
    h.runners.dsh.defaultStep = { start: 'rejected' };
    await h.engine.runUntilIdle();
    const run = firstRun(h, task.id);
    expect(run).toMatchObject({
      outcome: 'rejected',
      reject_reason: 'out_of_bounds: package.json',
    });
    expect(h.get(task.id).fix_notes).toContain('`package.json`');
    expect(h.checks.calls).toEqual([]);
  });

  it('step 4: a failing check → rejected checks_failed with only the last 20 lines in the fix ticket', async () => {
    const { h, task } = setup();
    const output = Array.from({ length: 40 }, (_, i) => `err ${i + 1}`).join('\n');
    h.checks.setResult('test', { passed: false, tail: output });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.runners.dsh.defaultStep = { start: 'rejected' };
    await h.engine.runUntilIdle();
    const run = firstRun(h, task.id);
    expect(run).toMatchObject({ outcome: 'rejected', reject_reason: 'checks_failed: test' });
    const notes = h.get(task.id).fix_notes!;
    expect(notes).toContain('err 40');
    expect(notes).toContain('err 21');
    expect(notes).not.toContain('err 20\n');
    const verified = h.store.events.listAfter(0).find((e) => e.type === 'run.verified');
    expect(verified?.data).toMatchObject({
      outcome: 'rejected',
      checks: [{ name: 'test', passed: false }],
    });
  });

  it('step 4: runs every check one by one', async () => {
    const h = createTestEngine();
    h.project({
      checks: [
        { name: 'lint', cmd: 'pnpm lint' },
        { name: 'test', cmd: 'pnpm test' },
      ],
    });
    const task = h.task();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    await h.engine.runUntilIdle();
    expect(h.checks.calls.map((c) => [c.name, c.cmd])).toEqual([
      ['lint', 'pnpm lint'],
      ['test', 'pnpm test'],
    ]);
    expect(h.get(task.id).status).toBe('done');
  });

  it('step 5: commit failures retry the verify effect; exhausted retries block the task', async () => {
    const { h, task } = setup();
    h.git.failNext('commitAll', 1);
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('verifying');
    expect(h.store.effects.get('run.verify', firstRun(h, task.id).id)).toMatchObject({
      attempts: 1,
    });
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');

    const h2 = createTestEngine({
      config: { engine: { ...h.config.engine, effect_max_attempts: 2 } },
    });
    const t2 = h2.task();
    h2.git.failNext('commitAll', 5);
    h2.runners.dsh.script(editing(h2.git, ['src/feature/a.ts']));
    await h2.engine.runUntilIdle();
    h2.clock.advance(5000);
    await h2.engine.runUntilIdle();
    const blocked = h2.get(t2.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked_reason).toContain('commitAll');
    expect(h2.store.runs.list({ task_id: t2.id })[0]?.reject_reason).toMatch(/^verify_error/);
    expect(h2.eventTypes()).toContain('effect.dead');
  });
});
