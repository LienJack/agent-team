import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, TeamError } from '../errors.js';
import { createTestEngine, editing } from '../testing/harness.js';
import { saveTask } from './records.js';

const LEADER = { kind: 'leader' } as const;

/** Tick and yield until the task reaches `status` (work that never settles is not awaited). */
async function untilStatus(
  h: ReturnType<typeof createTestEngine>,
  taskId: string,
  status: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (h.get(taskId).status === status && (status !== 'verifying' || h.checks.calls.length > 0)) {
      return;
    }
    void h.engine.tick();
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
  throw new Error(`task ${taskId} never reached ${status} (is ${h.get(taskId).status})`);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof TeamError ? err.code : 'not a TeamError';
  }
  return undefined;
}

describe('H4 source status guards on every command', () => {
  it('queue only applies to draft tasks: running → queued is refused', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ hold: true });
    const task = h.task();
    await h.engine.drain();
    expect(h.get(task.id).status).toBe('running');
    expect(() => h.engine.queueTask(task.id)).toThrow(ConflictError);
    expect(h.get(task.id)).toMatchObject({ status: 'running' });
    expect(h.store.runs.list({ task_id: task.id })[0]!.state).toBe('running');
  });

  it('verifying → queued is refused (the pending verification is not stranded)', async () => {
    const h = createTestEngine();
    h.checks.setResult('test', 'hang');
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await untilStatus(h, task.id, 'verifying');
    expect(h.checks.calls).toHaveLength(1); // the check is running (hangs)
    expect(codeOf(() => h.engine.queueTask(task.id))).toBe('conflict');
    expect(h.get(task.id).status).toBe('verifying');
    await h.engine.shutdown();
  });

  it('review → queued is refused (committed work waits for its reviewer)', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.runners.codex.script({ hold: true });
    h.runners.claude.script({ hold: true });
    const task = h.task();
    await h.engine.drain();
    expect(h.get(task.id).status).toBe('review');
    expect(() => h.engine.queueTask(task.id)).toThrow(/draft/);
    expect(h.get(task.id).status).toBe('review');
  });

  it('queue from draft still works', () => {
    const h = createTestEngine();
    const task = h.task({ queue: false });
    expect(h.engine.queueTask(task.id).status).toBe('queued');
  });

  it('retry only from blocked/failed; approve/reject only from review', () => {
    const h = createTestEngine();
    const task = h.task({ queue: false });
    expect(codeOf(() => h.engine.retryTask(task.id))).toBe('conflict');
    expect(codeOf(() => h.engine.approveTask(task.id))).toBe('conflict');
    expect(codeOf(() => h.engine.rejectTask(task.id, 'x'))).toBe('conflict');
  });
});

describe('H1 actor model in the engine: human-only commands', () => {
  it('the leader cannot approve, reject, answer, reassign or register projects', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.runners.codex.script({ hold: true });
    h.runners.claude.script({ hold: true });
    const task = h.task();
    await h.engine.drain();
    expect(h.get(task.id).status).toBe('review');
    const item = h.engine.openAttention({ task_id: task.id, question: 'q?', options: ['a'] });

    expect(() => h.engine.approveTask(task.id, undefined, LEADER)).toThrow(ForbiddenError);
    expect(() => h.engine.rejectTask(task.id, 'no', LEADER)).toThrow(ForbiddenError);
    expect(() => h.engine.answerAttention(item.id, 'a', 'cli', LEADER)).toThrow(ForbiddenError);
    expect(() => h.engine.reassignTask(task.id, 'impl_B', LEADER)).toThrow(ForbiddenError);
    expect(() =>
      h.engine.createProject({ name: 'other', repo_path: '/repos/other' }, LEADER),
    ).toThrow(ForbiddenError);
    expect(h.get(task.id).status).toBe('review');
    expect(h.store.attention.get(item.id)!.status).toBe('open');
    // humans still can
    expect(h.engine.approveTask(task.id).status).toBe('done');
  });
});

describe('M6 leader retries', () => {
  function blocked(h: ReturnType<typeof createTestEngine>, patch: { attempts?: number } = {}) {
    const task = h.task({ queue: false });
    return (
      h.engine.ctx.transact((tx) => saveTask(tx, h.get(task.id), { status: 'queued' })) &&
      h.engine.ctx.transact((tx) =>
        saveTask(tx, h.get(task.id), { status: 'blocked', blocked_reason: 'x', ...patch }),
      )
    );
  }

  it('refuses a leader retry of a start_unknown block (human only)', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ start: 'unknown' });
    const task = h.task();
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('blocked');
    expect(() => h.engine.retryTask(task.id, LEADER)).toThrow(ForbiddenError);
    expect(h.engine.retryTask(task.id).status).toBe('queued');
  });

  it('refuses a leader retry of a task that exhausted its attempts (failed)', () => {
    const h = createTestEngine();
    const task = blocked(h);
    h.engine.ctx.transact((tx) => saveTask(tx, h.get(task.id), { status: 'queued' }));
    h.engine.ctx.transact((tx) => saveTask(tx, h.get(task.id), { status: 'failed', attempts: 3 }));
    expect(() => h.engine.retryTask(task.id, LEADER)).toThrow(ForbiddenError);
  });

  it('a leader retry keeps attempts and counts against a per-task budget', () => {
    const h = createTestEngine();
    expect(h.config.engine.leader_retry_budget).toBe(2);
    const task = blocked(h, { attempts: 2 });
    const first = h.engine.retryTask(task.id, LEADER);
    expect(first).toMatchObject({ status: 'queued', attempts: 2, leader_retries: 1 });
    h.engine.ctx.transact((tx) =>
      saveTask(tx, h.get(task.id), { status: 'blocked', blocked_reason: 'again' }),
    );
    expect(h.engine.retryTask(task.id, LEADER).leader_retries).toBe(2);
    h.engine.ctx.transact((tx) =>
      saveTask(tx, h.get(task.id), { status: 'blocked', blocked_reason: 'again' }),
    );
    expect(codeOf(() => h.engine.retryTask(task.id, LEADER))).toBe('forbidden');
    // a human retry resets both counters
    expect(h.engine.retryTask(task.id)).toMatchObject({ attempts: 0, leader_retries: 0 });
  });
});
