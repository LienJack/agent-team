import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  IdempotencyConflictError,
  InvalidTransitionError,
  NotFoundError,
  RequestInProgressError,
  ValidationError,
  VersionConflictError,
} from '../errors.js';
import { withIdempotency } from '../idempotency.js';
import { createTestEngine, editing } from '../testing/harness.js';
import { notify } from './notify.js';
import { saveTask } from './records.js';

describe('§14 樂觀鎖 — optimistic lock and transition table in the engine', () => {
  it('rejects illegal transitions and stale versions', () => {
    const h = createTestEngine();
    const task = h.task({ queue: false });
    expect(() => h.engine.approveTask(task.id)).toThrow(ConflictError);
    expect(() =>
      h.engine.ctx.transact((tx) => saveTask(tx, h.get(task.id), { status: 'done' })),
    ).toThrow(InvalidTransitionError);
    const stale = h.get(task.id);
    h.engine.queueTask(task.id);
    expect(() => h.engine.ctx.transact((tx) => saveTask(tx, stale, { priority: 3 }))).toThrow(
      VersionConflictError,
    );
    expect(h.get(task.id)).toMatchObject({ status: 'queued', version: 2, priority: 0 });
  });
});

describe('task commands', () => {
  it('createTask validates project, role and paths and defaults impl_role from the tier', () => {
    const h = createTestEngine();
    const p = h.project();
    const base = {
      project_id: p.id,
      title: 't',
      tier: 'B' as const,
      ticket_md: '#',
      owned_paths: ['src/'],
    };
    expect(h.engine.createTask(base)).toMatchObject({
      impl_role: 'impl_B',
      status: 'draft',
      version: 1,
    });
    expect(() => h.engine.createTask({ ...base, project_id: 'p_nope' })).toThrow(NotFoundError);
    expect(() => h.engine.createTask({ ...base, impl_role: 'impl_Z' })).toThrow(ValidationError);
    expect(() => h.engine.createTask({ ...base, owned_paths: ['/etc'] })).toThrow(ValidationError);
    expect(() => h.engine.createProject({ name: p.name, repo_path: '/x' })).toThrow(ConflictError);
  });

  it('cancel stops the live run; its late result is fenced off', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ hold: true });
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    const cancelled = h.engine.cancelTask(task.id, '不需要了');
    expect(cancelled).toMatchObject({ status: 'cancelled', current_run_id: null });
    expect(h.store.runs.get(run.id)).toMatchObject({ state: 'stopped', outcome: 'cancelled' });
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('cancelled');
    expect(h.store.workspaces.findCurrentByTask(task.id)?.state).toBe('kept');
    expect(() => h.engine.cancelTask(task.id)).toThrow(ConflictError);
  });

  it('retry only applies to blocked or failed tasks', () => {
    const h = createTestEngine();
    const task = h.task();
    expect(() => h.engine.retryTask(task.id)).toThrow(/only blocked or failed/);
  });
});

describe('attention handling', () => {
  it('open, answer once, and supersede when the task moves on', async () => {
    const h = createTestEngine();
    const task = h.task();
    const a = h.engine.openAttention({
      task_id: task.id,
      question: '用 A 還是 B？',
      options: ['A', 'B'],
    });
    expect(a).toMatchObject({ kind: 'decision', status: 'open', options: ['A', 'B'] });
    expect(h.store.outbox.findBySignature(`attention:${a.id}`)).toBeDefined();
    const answered = h.engine.answerAttention(a.id, 'A', 'web');
    expect(answered).toMatchObject({ status: 'answered', answer: 'A', answered_via: 'web' });
    expect(() => h.engine.answerAttention(a.id, 'B', 'cli')).toThrow(ConflictError);
    expect(() => h.engine.answerAttention('a_nope', 'B', 'cli')).toThrow(NotFoundError);
    expect(() => h.engine.openAttention({ task_id: 't_nope', question: 'x' })).toThrow(
      NotFoundError,
    );

    const open = h.engine.openAttention({ task_id: task.id, question: '還有問題' });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
    expect(h.store.attention.get(open.id)?.status).toBe('superseded');
    expect(h.eventTypes(task.id)).toEqual(
      expect.arrayContaining(['attention.opened', 'attention.answered', 'attention.superseded']),
    );
  });

  it('notification signatures are never queued twice (also after a restart)', () => {
    const h = createTestEngine();
    const input = {
      kind: 'task_done' as const,
      signature: 'task_done:t_x',
      body: 'done',
      task_id: null,
    };
    const first = h.engine.ctx.transact((tx) => notify(h.engine.ctx, tx, input));
    const second = h.engine.ctx.transact((tx) => notify(h.engine.ctx, tx, input));
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    const restarted = createTestEngine({ store: h.store, idOffset: 1000 });
    expect(
      restarted.engine.ctx.transact((tx) => notify(restarted.engine.ctx, tx, input)),
    ).toBeUndefined();
    expect(h.store.outbox.list().filter((o) => o.signature === 'task_done:t_x')).toHaveLength(1);
  });
});

describe('messages', () => {
  it('dedupe by (channel, client_msg_id)', () => {
    const h = createTestEngine();
    const first = h.engine.recordMessage({
      channel: 'leader',
      direction: 'in',
      source: 'web',
      body: 'hi',
      client_msg_id: 'c1',
    });
    const again = h.engine.recordMessage({
      channel: 'leader',
      direction: 'in',
      source: 'cli',
      body: 'hi?',
      client_msg_id: 'c1',
    });
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ message: first.message, duplicate: true });
    const other = h.engine.recordMessage({
      channel: 'grok',
      direction: 'in',
      source: 'grok',
      body: 'x',
      client_msg_id: 'c1',
    });
    expect(other.duplicate).toBe(false);
    expect(h.engine.setMessageStatus(first.message.id, 'delivered').status).toBe('delivered');
    expect(h.eventTypes()).toEqual(
      expect.arrayContaining(['message.created', 'message.status_changed']),
    );
  });
});

describe('idempotency helper', () => {
  it('replays the same request, rejects a different payload, and frees the key on failure', async () => {
    const h = createTestEngine();
    let calls = 0;
    const req = {
      caller: 'cli',
      requestId: 'k1',
      method: 'POST /api/tasks',
      payload: { b: 1, a: [1] },
    };
    const run = () =>
      withIdempotency(h.store, h.clock, req, async () => ({ status: 201, body: { n: ++calls } }));
    expect(await run()).toEqual({ response: { status: 201, body: { n: 1 } }, replayed: false });
    // same payload with keys in another order is the same request
    const replay = await withIdempotency(
      h.store,
      h.clock,
      { ...req, payload: { a: [1], b: 1 } },
      async () => ({ status: 500, body: null }),
    );
    expect(replay).toEqual({ response: { status: 201, body: { n: 1 } }, replayed: true });
    await expect(
      withIdempotency(h.store, h.clock, { ...req, payload: { b: 2 } }, async () => ({
        status: 200,
        body: null,
      })),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(calls).toBe(1);

    // a request in progress blocks a concurrent duplicate
    let release!: () => void;
    const slow = withIdempotency(h.store, h.clock, { ...req, requestId: 'k2' }, async () => {
      await new Promise<void>((r) => (release = r));
      return { status: 200, body: 'ok' };
    });
    await expect(
      withIdempotency(h.store, h.clock, { ...req, requestId: 'k2' }, async () => ({
        status: 200,
        body: null,
      })),
    ).rejects.toThrow(RequestInProgressError);
    release();
    await slow;

    // a thrown handler leaves no record behind
    await expect(
      withIdempotency(h.store, h.clock, { ...req, requestId: 'k3' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(h.store.idempotency.get('cli', 'k3')).toBeUndefined();
    // different callers never collide
    const other = await withIdempotency(h.store, h.clock, { ...req, caller: 'web' }, async () => ({
      status: 202,
      body: 'w',
    }));
    expect(other.replayed).toBe(false);
  });
});
