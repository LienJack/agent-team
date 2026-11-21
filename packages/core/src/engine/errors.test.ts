import { runnerHealthKey } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';

describe('§14 冷卻與改派 — rate limit: cooldown and reassignment', () => {
  it('cools the runner down until resetsAt, requeues without consuming attempts, falls back', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'B', impl_role: 'impl_B' }); // gpt-sol (codex) → kimi-pro (dsh)
    h.runners.codex.script({
      result: {
        error: { kind: 'rate_limit', message: '429' },
        quota: { resetsAt: '2026-11-21T02:00:00.000Z', utilization: 1, exhausted: true },
      },
    });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    await h.engine.runUntilIdle();

    const [limited, fallback] = h.store.runs.list({ task_id: task.id });
    expect(limited).toMatchObject({ runner: 'codex', state: 'failed', outcome: 'rate_limited' });
    expect(fallback).toMatchObject({ runner: 'dsh', model_alias: 'kimi-pro', kind: 'impl' });
    const health = JSON.parse(h.store.kv.get(runnerHealthKey('codex'))!);
    expect(health.cooldown_until).toBe('2026-11-21T02:00:00.000Z');
    expect(health.consecutive_failures).toBe(0); // rate limits do not trip the breaker
    expect(h.eventTypes()).toContain('runner.cooldown');
    expect(h.notifier.sent.map((o) => o.kind)).toContain('quota_exhausted');
    expect(h.get(task.id)).toMatchObject({ attempts: 0 });
    // the reviewer is review_B (sonnet on claude), unaffected
    expect(h.get(task.id).status).toBe('done');
  });

  it('defaults the cooldown to 15 minutes without resetsAt, then uses the runner again', async () => {
    const h = createTestEngine();
    const task = h.task(); // impl_C: dsh only
    h.runners.dsh.script({ result: { error: { kind: 'rate_limit', message: 'slow down' } } });
    await h.engine.runUntilIdle();
    const health = JSON.parse(h.store.kv.get(runnerHealthKey('dsh'))!);
    expect(health.cooldown_until).toBe('2026-11-21T00:15:00.000Z');
    expect(h.get(task.id)).toMatchObject({ status: 'queued', attempts: 0 });

    h.clock.advance(14 * 60 * 1000);
    await h.engine.runUntilIdle();
    expect(h.runners.dsh.calls).toHaveLength(1);
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.clock.advance(60 * 1000);
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
  });

  it('reassign switches the role for the next run', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.script({ result: { error: { kind: 'rate_limit', message: '429' } } });
    await h.engine.runUntilIdle();
    h.runners.claude.script(editing(h.git, ['src/feature/a.ts']));
    const t = h.engine.reassignTask(task.id, 'impl_A');
    expect(t).toMatchObject({ impl_role: 'impl_A', fix_rounds: 0, status: 'queued' });
    await h.engine.runUntilIdle();
    expect(h.store.runs.list({ task_id: task.id }).map((r) => r.role)).toEqual([
      'impl_C',
      'impl_A',
      'review_C',
    ]);
    expect(h.get(task.id).status).toBe('done');
  });

  it('reassign is refused while a run is in flight', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.script({ hold: true });
    await h.engine.drain();
    expect(() => h.engine.reassignTask(task.id, 'impl_A')).toThrow(/run in progress/);
    expect(() => h.engine.reassignTask(task.id, 'nope')).toThrow(/unknown or disabled role/);
    h.runners.dsh.release(undefined, { error: { kind: 'crash', message: 'x' } });
    await h.engine.runUntilIdle();
  });
});

describe('other errors: attempts and exponential backoff', () => {
  it('counts attempts with 5s, 10s backoff and fails at max_attempts', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.defaultStep = {
      result: { error: { kind: 'timeout', message: 'took too long' } },
    };
    await h.engine.runUntilIdle();
    expect(h.get(task.id)).toMatchObject({ attempts: 1, retry_at: '2026-11-21T00:00:05.000Z' });
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.get(task.id)).toMatchObject({ attempts: 2, retry_at: '2026-11-21T00:00:15.000Z' });
    h.clock.advance(10000);
    await h.engine.runUntilIdle();
    const failed = h.get(task.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 3, retry_at: null });
    expect(failed.blocked_reason).toContain('timeout');
    expect(h.store.runs.list({ task_id: task.id }).map((r) => r.outcome)).toEqual([
      'timeout',
      'timeout',
      'timeout',
    ]);
    expect(h.notifier.sent.map((o) => o.kind)).toContain('task_failed');

    // retry resets attempts; three dsh failures also opened dsh's circuit, so the task waits
    h.runners.dsh.defaultStep = editing(h.git, ['src/feature/a.ts']);
    h.engine.retryTask(task.id);
    await h.engine.runUntilIdle();
    expect(h.get(task.id)).toMatchObject({ status: 'queued', attempts: 0 });
    h.clock.advance(h.config.engine.circuit_open_ms);
    await h.engine.runUntilIdle();
    expect(h.get(task.id)).toMatchObject({ status: 'done', attempts: 0 });
  });
});

describe('circuit breaker', () => {
  it('opens after 3 consecutive failures of a runner, notifies, and closes after a good run', async () => {
    const h = createTestEngine({
      config: { engine: { ...createTestEngine().config.engine, max_attempts: 10 } },
    });
    const task = h.task({ tier: 'B', impl_role: 'impl_B' }); // codex first, then dsh fallback
    h.runners.codex.defaultStep = { result: { error: { kind: 'crash', message: 'segfault' } } };
    await h.engine.runUntilIdle();
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    h.clock.advance(10000);
    await h.engine.runUntilIdle();

    const codex = JSON.parse(h.store.kv.get(runnerHealthKey('codex'))!);
    expect(codex.consecutive_failures).toBe(3);
    expect(codex.circuit_open_until).toBe('2026-11-21T00:10:15.000Z');
    const opened = h.store.events.listAfter(0).find((e) => e.type === 'runner.circuit_opened');
    expect(opened?.data).toMatchObject({ runner: 'codex', failures: 3 });
    expect(h.notifier.sent.map((o) => o.kind)).toContain('circuit_open');
    expect(h.engine.runnerStatuses().find((s) => s.runner === 'codex')).toMatchObject({
      available: false,
      circuit: 'open',
    });

    // while open, the next attempt goes to the fallback runner
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.clock.advance(20000);
    await h.engine.runUntilIdle();
    const runs = h.store.runs.list({ task_id: task.id });
    expect(runs.filter((r) => r.kind === 'impl').map((r) => r.runner)).toEqual([
      'codex',
      'codex',
      'codex',
      'dsh',
    ]);
    expect(h.get(task.id).status).toBe('done');

    // after circuit_open_ms it is half-open; one good run closes it
    h.clock.advance(10 * 60 * 1000);
    expect(h.engine.runnerStatuses().find((s) => s.runner === 'codex')?.circuit).toBe('half_open');
    h.runners.codex.defaultStep = editing(h.git, ['src/other/b.ts']);
    const second = h.task({ tier: 'B', impl_role: 'impl_B', owned_paths: ['src/other/'] });
    await h.engine.runUntilIdle();
    expect(h.get(second.id).status).toBe('done');
    expect(h.engine.runnerStatuses().find((s) => s.runner === 'codex')?.circuit).toBe('closed');
    expect(h.eventTypes()).toContain('runner.circuit_closed');
  });
});
