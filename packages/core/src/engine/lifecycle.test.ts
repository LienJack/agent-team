import { EventRecordSchema, receiptJsonSchema } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';

describe('task lifecycle (happy path)', () => {
  it('queued → running → verifying → review → done with a service-side commit', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task({ title: '加入 a 功能' });

    await h.engine.runUntilIdle();

    const done = h.get(task.id);
    expect(done.status).toBe('done');
    const runs = h.store.runs.list({ task_id: task.id });
    expect(runs.map((r) => [r.kind, r.role, r.model_alias, r.state, r.outcome])).toEqual([
      ['impl', 'impl_C', 'deepseek-flash', 'succeeded', 'ok'],
      ['review', 'review_C', 'gpt-sol', 'succeeded', 'ok'],
    ]);
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    expect(ws).toMatchObject({
      path: `/worktrees/demo/${task.id}`,
      branch: `team/${task.id}`,
      state: 'active',
    });
    expect(ws.head_sha).not.toBeNull();
    const commit = h.git.calls.find((c) => c.method === 'commitFiles');
    expect(commit?.input).toMatchObject({ message: `team(${task.id}): 加入 a 功能` });
    expect(h.checks.calls.map((c) => c.name)).toEqual(['test']);
    expect(h.checks.calls[0]!.logPath).toBe(`/data/runs/${runs[0]!.id}/checks/1-test.log`);
    expect(h.store.effects.list()).toEqual([]);
  });

  it('writes an event for every state change, in order, all schema-valid', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.runUntilIdle();

    const statusChanges = h.store.events
      .listAfter(0)
      .filter((e) => e.type === 'task.status_changed' && e.task_id === task.id)
      .map((e) => (e.data as { to: string }).to);
    expect(statusChanges).toEqual(['running', 'verifying', 'review', 'done']);
    const types = h.eventTypes(task.id);
    for (const t of [
      'task.created',
      'workspace.created',
      'run.created',
      'run.dispatched',
      'run.state_changed',
      'run.finished',
      'run.verified',
      'commit.created',
      'review.completed',
    ] as const) {
      expect(types).toContain(t);
    }
    const all = h.store.events.listAfter(0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    for (const e of all) expect(EventRecordSchema.safeParse(e).success).toBe(true);
    // the publisher saw exactly the committed events, the leader a subset
    expect(h.publisher.events.map((e) => e.seq)).toEqual(all.map((e) => e.seq));
    expect(h.leader.events.length).toBeGreaterThan(0);
    expect(h.leader.events.every((e) => e.type !== 'run.created')).toBe(true);
  });

  it('builds the prompt from worker rules, ticket, receipt schema and dispatch id', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task({ ticket_md: '## 目標\n實作 X', owned_paths: ['src/feature/'] });
    await h.engine.runUntilIdle();

    const spec = h.runners.dsh.calls[0]!;
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(spec.dispatchId).toBe(run.dispatch_id);
    expect(spec).toMatchObject({
      cwd: `/worktrees/demo/${task.id}`,
      model: 'deepseek-flash',
      writable: true,
      logDir: `/data/runs/${run.id}`,
      timeoutMs: h.config.engine.run_timeout_ms,
    });
    expect(spec.env).toBeUndefined();
    expect(spec.schema).toEqual(receiptJsonSchema('impl'));
    expect(spec.prompt).toContain(run.dispatch_id);
    expect(spec.prompt).toContain('實作 X');
    expect(spec.prompt).toContain('`src/feature/`');
    expect(spec.prompt).toContain('不要 git commit');
    expect(spec.prompt).toContain('"needs_leader"');

    const reviewSpec = h.runners.codex.calls[0]!;
    expect(reviewSpec.writable).toBe(false);
    expect(reviewSpec.schema).toEqual(receiptJsonSchema('review'));
    expect(reviewSpec.prompt).toContain('唯讀審查');
  });

  it('queues outbox notifications and delivers them through the Notifier', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.runUntilIdle();
    expect(h.notifier.sent.map((o) => o.kind)).toEqual(['task_done']);
    expect(h.store.outbox.list()[0]).toMatchObject({
      status: 'sent',
      signature: `task_done:${task.id}`,
      attempts: 1,
    });
  });

  it('does not write outbox rows when notifications are disabled', async () => {
    const h = createTestEngine({ config: { notifications: false } });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.task();
    await h.engine.runUntilIdle();
    expect(h.store.outbox.list()).toEqual([]);
    expect(h.notifier.sent).toEqual([]);
  });

  it('keeps draft tasks out of scheduling until queued', async () => {
    const h = createTestEngine();
    const task = h.task({ queue: false });
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('draft');
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.engine.queueTask(task.id);
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
  });
});
