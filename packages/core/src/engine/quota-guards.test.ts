import { runnerHealthKey, type RunnerHealth } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTestEngine, editing, type TestEngine } from '../testing/harness.js';
import { defaultHealth } from './runner-health.js';
import {
  QUOTA_RESET_BUFFER_MS,
  QUOTA_RESET_JITTER_MAX_MS,
  quotaJitterMs,
  quotaWaitUntil,
} from './quota-wait.js';

// docs/adr/0022 §2: quota-wait guards (spec §8 錯誤, §7 quota) with the manual clock.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = new Date('2026-11-21T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

const health = (h: TestEngine, runner: string): RunnerHealth =>
  JSON.parse(h.store.kv.get(runnerHealthKey(runner))!) as RunnerHealth;
const rateLimit = (resetsAt?: string) => ({
  result: {
    error: { kind: 'rate_limit' as const, message: '429' },
    ...(resetsAt ? { quota: { resetsAt } } : {}),
  },
});

describe('quotaWaitUntil: cap, buffer and deterministic jitter', () => {
  it('waits past a plausible reset by 60 s plus a stable 0–30 s spread', () => {
    const reset = at(90 * MIN);
    const until = quotaWaitUntil(reset, T0, 'claude')!;
    const extra = Date.parse(until) - Date.parse(reset);
    expect(extra).toBe(QUOTA_RESET_BUFFER_MS + quotaJitterMs('claude', reset));
    expect(extra).toBeGreaterThanOrEqual(QUOTA_RESET_BUFFER_MS);
    expect(extra).toBeLessThanOrEqual(QUOTA_RESET_BUFFER_MS + QUOTA_RESET_JITTER_MAX_MS);
    // the same inputs always give the same time (no randomness in core)
    expect(quotaWaitUntil(reset, T0, 'claude')).toBe(until);
  });

  it('spreads runners and reset times over the jitter range', () => {
    const values = new Set<number>();
    for (const runner of ['claude', 'codex', 'dsh', 'fake']) {
      for (let i = 1; i <= 25; i++) values.add(quotaJitterMs(runner, at(i * MIN)));
    }
    expect(values.size).toBeGreaterThan(50);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(QUOTA_RESET_JITTER_MAX_MS);
    }
  });

  it('treats a reset in the past, now, unparseable or more than 8 days ahead as unknown', () => {
    expect(quotaWaitUntil(at(-MIN), T0, 'dsh')).toBeUndefined();
    expect(quotaWaitUntil(T0.toISOString(), T0, 'dsh')).toBeUndefined();
    expect(quotaWaitUntil('soon', T0, 'dsh')).toBeUndefined();
    expect(quotaWaitUntil(null, T0, 'dsh')).toBeUndefined();
    expect(quotaWaitUntil(at(8 * DAY + 1), T0, 'dsh')).toBeUndefined();
    expect(quotaWaitUntil(at(8 * DAY), T0, 'dsh')).toBeDefined();
  });
});

describe('rate-limit cooldown uses the guarded reset', () => {
  it('a reset more than 8 days ahead, or already past, cools down for the default 15 minutes', async () => {
    for (const reset of [at(30 * DAY), at(-5 * MIN)]) {
      const h = createTestEngine();
      h.task(); // impl_C: dsh only
      h.runners.dsh.script(rateLimit(reset));
      await h.engine.runUntilIdle();
      expect(health(h, 'dsh').cooldown_until).toBe(at(15 * MIN));
    }
  });

  it('an exhausted quota with an implausible reset does not park the runner for a month', async () => {
    const h = createTestEngine();
    h.task();
    h.runners.dsh.script({
      ...editing(h.git, ['src/feature/a.ts']),
      result: (spec) => ({
        final: {
          dispatch_id: spec.dispatchId,
          status: 'done',
          summary: 'ok',
          files_changed: ['src/feature/a.ts'],
          checks: [],
          needs_leader: '',
        },
        quota: { exhausted: true, resetsAt: at(30 * DAY), utilization: 1 },
      }),
    });
    await h.engine.runUntilIdle();
    expect(health(h, 'dsh').quota).toMatchObject({ exhausted: true, resets_at: at(30 * DAY) });
    const dsh = h.engine.runnerStatuses().find((s) => s.runner === 'dsh')!;
    expect(dsh.available).toBe(true);
  });

  it('a plausible exhausted quota holds the runner until reset + buffer + jitter', async () => {
    const h = createTestEngine();
    const reset = at(30 * MIN);
    h.task();
    h.runners.dsh.script({
      ...editing(h.git, ['src/feature/a.ts']),
      result: (spec) => ({
        final: {
          dispatch_id: spec.dispatchId,
          status: 'done',
          summary: 'ok',
          files_changed: ['src/feature/a.ts'],
          checks: [],
          needs_leader: '',
        },
        quota: { exhausted: true, resetsAt: reset, utilization: 1 },
      }),
    });
    await h.engine.runUntilIdle();
    const until = quotaWaitUntil(reset, T0, 'dsh')!;
    h.clock.advance(Date.parse(until) - T0.getTime() - 1);
    expect(h.engine.runnerStatuses().find((s) => s.runner === 'dsh')!.available).toBe(false);
    h.clock.advance(1);
    expect(h.engine.runnerStatuses().find((s) => s.runner === 'dsh')!.available).toBe(true);
  });
});

/** Let the current cooldown of `runner` pass. */
function passCooldown(h: TestEngine, runner: string): void {
  const until = Date.parse(health(h, runner).cooldown_until!);
  h.clock.advance(Math.max(0, until - h.clock.now().getTime() + 1));
}

describe('rate-limit loop guard', () => {
  it('stops resuming after 3 cooldowns whose first run hit the limit again; an answer re-arms', async () => {
    const h = createTestEngine();
    const task = h.task(); // impl_C: deepseek-flash → glm-flash, both dsh: no other runner
    h.runners.dsh.script(rateLimit(), rateLimit(), rateLimit());
    await h.engine.runUntilIdle(); // cooldown 1 (the first limit is not after a cooldown)
    expect(health(h, 'dsh').rate_limit_loops).toBe(0);
    for (const loops of [1, 2]) {
      passCooldown(h, 'dsh');
      await h.engine.runUntilIdle();
      expect(health(h, 'dsh')).toMatchObject({ rate_limit_loops: loops, halted_at: null });
    }
    h.runners.dsh.script(rateLimit());
    passCooldown(h, 'dsh');
    await h.engine.runUntilIdle();

    const halted = health(h, 'dsh');
    expect(halted).toMatchObject({ rate_limit_loops: 3, halted_at: h.clock.now().toISOString() });
    const status = h.engine.runnerStatuses().find((s) => s.runner === 'dsh')!;
    expect(status).toMatchObject({ available: false, circuit: 'open' });
    const items = h.store.attention.list({ statuses: ['open'] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      topic: 'runner_halted',
      task_id: null,
      options: ['重新啟用'],
    });
    expect(items[0]!.question).toContain('dsh');
    expect(halted.halted_attention_id).toBe(items[0]!.id);
    expect(h.eventTypes()).toContain('runner.halted');
    expect(h.notifier.sent.map((o) => o.kind)).toContain('attention');

    // no automatic resumption: hours later nothing more is dispatched on dsh
    const calls = h.runners.dsh.calls.length;
    h.clock.advance(6 * 60 * MIN);
    await h.engine.runUntilIdle();
    expect(h.runners.dsh.calls).toHaveLength(calls);
    expect(h.get(task.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(h.engine.waitingOf(task.id)?.reason).toBe('runner_cooldown');

    // any answer re-arms it (Grok included: the item is not high risk)
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.engine.answerAttention(items[0]!.id, '重新啟用', 'grok');
    expect(health(h, 'dsh')).toMatchObject({ rate_limit_loops: 0, halted_at: null });
    await h.engine.runUntilIdle();
    expect(h.runners.dsh.calls.length).toBeGreaterThan(calls);
    expect(['review', 'done']).toContain(h.get(task.id).status);
  });

  it('routes the role to its fallback runner while halted', async () => {
    const h = createTestEngine();
    const halted = { ...defaultHealth('codex'), halted_at: T0.toISOString() };
    h.store.kv.set(runnerHealthKey('codex'), JSON.stringify(halted));
    const task = h.task({ tier: 'B', impl_role: 'impl_B' }); // gpt-sol (codex) → kimi-pro (dsh)
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    await h.engine.runUntilIdle();
    const impl = h.store.runs.list({ task_id: task.id }).filter((r) => r.kind === 'impl');
    expect(impl).toHaveLength(1);
    expect(impl[0]).toMatchObject({ runner: 'dsh', model_alias: 'kimi-pro' });
    expect(h.runners.codex.calls.filter((c) => c.writable)).toHaveLength(0);
  });

  it('a successful run in between resets the count', async () => {
    const h = createTestEngine();
    h.task();
    h.runners.dsh.script(rateLimit(), rateLimit());
    await h.engine.runUntilIdle(); // cooldown 1
    passCooldown(h, 'dsh');
    await h.engine.runUntilIdle(); // first run after it: limit again → 1
    expect(health(h, 'dsh').rate_limit_loops).toBe(1);
    passCooldown(h, 'dsh');
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    await h.engine.runUntilIdle(); // a success
    expect(health(h, 'dsh')).toMatchObject({ rate_limit_loops: 0, probe_after_cooldown: false });
    // the count starts over: the next limit is not "after a cooldown" yet
    h.task({ title: '第二張', owned_paths: ['src/other/'] });
    h.runners.dsh.script(rateLimit());
    h.clock.advance(MIN);
    await h.engine.runUntilIdle();
    expect(health(h, 'dsh')).toMatchObject({ rate_limit_loops: 0, probe_after_cooldown: true });
  });

  it('counts one loop per cooldown window, not one per run that was already in flight', async () => {
    const h = createTestEngine();
    h.task();
    h.task({ title: '第二張', owned_paths: ['src/other/'] }); // impl_C has 3 slots: both run
    h.runners.dsh.script(rateLimit(), rateLimit());
    await h.engine.runUntilIdle();
    expect(h.runners.dsh.calls).toHaveLength(2);
    expect(health(h, 'dsh').rate_limit_loops).toBe(0);
    passCooldown(h, 'dsh');
    h.runners.dsh.script(rateLimit(), rateLimit());
    await h.engine.runUntilIdle();
    // both runs started after the cooldown; only the first result opens a new window
    expect(h.runners.dsh.calls).toHaveLength(4);
    expect(health(h, 'dsh').rate_limit_loops).toBe(1);
  });

  it('a human retry of a task that uses the runner re-arms it and supersedes the item', async () => {
    const h = createTestEngine();
    h.task();
    h.runners.dsh.script(rateLimit(), rateLimit(), rateLimit(), rateLimit());
    await h.engine.runUntilIdle();
    for (let i = 0; i < 3; i++) {
      passCooldown(h, 'dsh');
      await h.engine.runUntilIdle();
    }
    const item = h.store.attention.list({ statuses: ['open'] })[0]!;
    expect(item.topic).toBe('runner_halted');
    // another impl_C task got blocked for its own reasons; a person retries it
    const other = h.task({ title: '另一張', owned_paths: ['src/x/'], queue: false });
    h.store.tasks.update({ ...other, status: 'blocked', blocked_reason: 'x' }, other.version);
    h.runners.dsh.defaultStep = editing(h.git, ['src/feature/a.ts']);
    h.engine.retryTask(other.id, { kind: 'human' });
    expect(health(h, 'dsh').halted_at).toBeNull();
    expect(h.store.attention.get(item.id)?.status).toBe('superseded');
    expect(h.eventTypes()).toContain('runner.circuit_closed');
  });

  it('a leader retry does not re-arm', async () => {
    const h = createTestEngine();
    h.task();
    h.runners.dsh.script(rateLimit(), rateLimit(), rateLimit(), rateLimit());
    await h.engine.runUntilIdle();
    for (let i = 0; i < 3; i++) {
      passCooldown(h, 'dsh');
      await h.engine.runUntilIdle();
    }
    const other = h.task({ title: '另一張', owned_paths: ['src/x/'], queue: false });
    h.store.tasks.update({ ...other, status: 'blocked', blocked_reason: 'x' }, other.version);
    h.engine.retryTask(other.id, { kind: 'leader' });
    expect(health(h, 'dsh').halted_at).not.toBeNull();
  });
});

describe('high-risk attention items are not answerable from Grok (docs/adr/0022 §3)', () => {
  it('refuses a Grok answer to a start_unknown item and accepts the same answer from the CLI', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.script({ start: 'unknown' });
    await h.engine.runUntilIdle();
    const item = h.store.attention.list({ task_id: task.id, statuses: ['open'] })[0]!;
    expect(item.topic).toBe('start_unknown');
    expect(() => h.engine.answerAttention(item.id, '重試', 'grok')).toThrow(/board or the CLI/);
    expect(h.store.attention.get(item.id)?.status).toBe('open');
    expect(h.engine.answerAttention(item.id, '重試', 'cli').status).toBe('answered');
  });
});
