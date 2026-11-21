import { createTestEngine, editing } from '@agent-team/core/testing';
import {
  EffectRecordSchema,
  EventRecordSchema,
  MessageSchema,
  ProjectSchema,
  RunSchema,
  TaskSchema,
  WorkspaceSchema,
} from '@agent-team/schema';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type SqliteStore } from './index.js';
import { tempDir } from './testing.js';

// The core engine (with fake ports) on the SQLite store: the flows the in-memory store is tested
// with in core also work when every write goes through SQLite, including a restart (new process
// = new connection on the same file).

let tmp: ReturnType<typeof tempDir>;
let path: string;
const open: SqliteStore[] = [];
function openStore(): SqliteStore {
  const store = createSqliteStore({ path });
  open.push(store);
  return store;
}

beforeEach(() => {
  tmp = tempDir();
  path = join(tmp.dir, 'team.db');
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  tmp.remove();
});

describe('engine on SQLite', () => {
  it('happy path to done; every stored row parses with its Zod schema', async () => {
    const store = openStore();
    const h = createTestEngine({ store });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task({ title: '加入 a 功能' });
    await h.engine.runUntilIdle();

    expect(h.get(task.id).status).toBe('done');
    expect(store.effects.list()).toEqual([]);
    const events = store.events.listAfter(0);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(h.publisher.events.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    for (const e of events) expect(EventRecordSchema.parse(e)).toEqual(e);
    for (const p of store.projects.list()) expect(ProjectSchema.parse(p)).toEqual(p);
    for (const t of store.tasks.list()) expect(TaskSchema.parse(t)).toEqual(t);
    for (const w of store.workspaces.list()) expect(WorkspaceSchema.parse(w)).toEqual(w);
    const runs = store.runs.list({ task_id: task.id });
    expect(runs.map((r) => [r.kind, r.state, r.outcome])).toEqual([
      ['impl', 'succeeded', 'ok'],
      ['review', 'succeeded', 'ok'],
    ]);
    for (const r of runs) expect(RunSchema.parse(r)).toEqual(r);
    expect(runs[0]!.receipt).toMatchObject({ dispatch_id: runs[0]!.dispatch_id, status: 'done' });
  });

  it('effects written before a crash are still there for the next process', async () => {
    const before = openStore();
    const h = createTestEngine({ store: before });
    h.runners.dsh.script({ hold: true });
    const task = h.task();
    await h.engine.drain();
    const run = before.runs.list({ task_id: task.id })[0]!;
    expect(run.state).toBe('running');
    for (const e of before.effects.list()) expect(EffectRecordSchema.parse(e)).toEqual(e);
    const lastSeq = before.events.lastSeq();
    before.close(); // "crash": the held run never reports back

    const store = openStore();
    const after = createTestEngine({ store, idOffset: 1000 });
    const ws = store.workspaces.findCurrentByTask(task.id)!;
    after.git.worktrees.set(ws.path, h.git.worktrees.get(ws.path)!);
    const report = await after.engine.recover();
    expect(report.abandonedRuns).toEqual([run.id]);
    expect(store.runs.get(run.id)?.state).toBe('abandoned');
    expect(store.events.listAfter(lastSeq)[0]?.seq).toBe(lastSeq + 1);

    after.runners.dsh.script(editing(after.git, ['src/feature/a.ts']));
    await after.engine.runUntilIdle();
    expect(store.tasks.get(task.id)).toMatchObject({ status: 'done', recovery_note: null });
  });

  it('leader messages are deduplicated by client_msg_id across reopen', () => {
    const a = openStore();
    const m = a.messages.insert({
      id: 'm_1',
      channel: 'leader',
      direction: 'in',
      source: 'web',
      body: '你好',
      client_msg_id: 'c1',
      ref: null,
      status: 'new',
      created_at: '2026-11-21T00:00:00.000Z',
    });
    expect(MessageSchema.parse(m)).toEqual(m);
    a.close();
    const b = openStore();
    expect(b.messages.findByClientMsgId('leader', 'c1')).toEqual(m);
  });
});
