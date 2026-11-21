import { UniqueViolationError } from '@agent-team/core';
import {
  sampleOutbox,
  sampleProject,
  sampleRun,
  sampleTask,
  sampleWorkspace,
} from '@agent-team/core/testing';
import type { NewEvent, NewMessage } from '@agent-team/schema';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type SqliteStore } from './index.js';
import { tempDir } from './testing.js';

const T = (n: number) => `2026-11-21T00:00:${String(n).padStart(2, '0')}.000Z`;

const ev = (n: number): NewEvent => ({
  ts: T(n),
  type: 'task.status_changed',
  data: { from: 'queued', to: 'running', reason: null },
  task_id: 't_000001',
  run_id: null,
});

const msg = (id: string, clientMsgId: string, channel: NewMessage['channel'] = 'leader') =>
  ({
    id,
    channel,
    direction: 'in',
    source: 'cli',
    body: '嗨',
    client_msg_id: clientMsgId,
    ref: null,
    status: 'new',
    created_at: T(0),
  }) satisfies NewMessage;

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

describe('persistence', () => {
  it('data survives close and reopen; sequences continue', () => {
    const a = openStore();
    a.atomic((tx) => {
      tx.projects.insert(sampleProject());
      tx.tasks.insert(sampleTask({ owned_paths: ['src/a/', 'b/**'], fix_notes: '修正' }));
      tx.workspaces.insert(sampleWorkspace());
      tx.runs.insert(sampleRun({ usage: { input_tokens: 5 }, cost_usd: 0.25, pid: 42 }));
      tx.events.append(ev(1));
      tx.events.append(ev(2));
      tx.messages.insert(msg('m_1', 'c1'));
      tx.effects.upsert({ kind: 'run.start', key: 'r_000001', payload: { a: [1] }, due: T(1) });
      tx.outbox.insert(sampleOutbox());
      tx.kv.set('leader_session', 'abc');
    });
    const before = {
      project: a.projects.list(),
      task: a.tasks.list(),
      workspace: a.workspaces.list(),
      run: a.runs.list(),
      events: a.events.listAfter(0),
      messages: a.messages.list(),
      effects: a.effects.list(),
      outbox: a.outbox.list(),
      kv: a.kv.list(),
    };
    a.close();

    const b = openStore();
    expect({
      project: b.projects.list(),
      task: b.tasks.list(),
      workspace: b.workspaces.list(),
      run: b.runs.list(),
      events: b.events.listAfter(0),
      messages: b.messages.list(),
      effects: b.effects.list(),
      outbox: b.outbox.list(),
      kv: b.kv.list(),
    }).toEqual(before);
    expect(b.tasks.get('t_000001')?.owned_paths).toEqual(['src/a/', 'b/**']);
    expect(b.events.lastSeq()).toBe(2);
    expect(b.events.append(ev(3)).seq).toBe(3);
    expect(b.messages.insert(msg('m_2', 'c2')).seq).toBe(2);
    const effect = b.effects.upsert({ kind: 'run.verify', key: 'r_1', payload: null, due: T(2) });
    expect(effect.seq).toBe(2);
    expect(effect.payload).toBeNull();
  });

  it('createSqliteStore creates missing parent directories', () => {
    path = join(tmp.dir, 'a', 'b', 'team.db');
    const store = openStore();
    store.kv.set('k', 'v');
    expect(store.kv.get('k')).toBe('v');
  });

  it('opens :memory: databases (migrated, without WAL)', () => {
    const store = createSqliteStore({ path: ':memory:' });
    open.push(store);
    store.events.append(ev(1));
    expect(store.events.lastSeq()).toBe(1);
    expect(store.connection.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'memory',
    });
  });

  it('close() is idempotent', () => {
    const store = openStore();
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});

describe('transactions', () => {
  it('a throw rolls back every write, also on disk', () => {
    const a = openStore();
    a.projects.insert(sampleProject());
    a.tasks.insert(sampleTask());
    expect(() =>
      a.atomic((tx) => {
        const t = tx.tasks.get('t_000001')!;
        tx.tasks.update({ ...t, status: 'running' }, t.version);
        tx.events.append(ev(1));
        tx.kv.set('x', '1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    a.close();
    const b = openStore();
    expect(b.tasks.get('t_000001')).toMatchObject({ status: 'queued', version: 1 });
    expect(b.events.lastSeq()).toBe(0);
    expect(b.kv.get('x')).toBeUndefined();
  });

  it('rethrows the original error object', () => {
    const s = openStore();
    const err = new RangeError('original');
    let caught: unknown;
    try {
      s.atomic(() => {
        throw err;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });

  it('a nested throw caught by the caller undoes only the inner writes (savepoint)', () => {
    const s = openStore();
    s.atomic((tx) => {
      tx.kv.set('outer', '1');
      expect(() =>
        s.atomic((inner) => {
          inner.kv.set('inner', '1');
          throw new Error('inner');
        }),
      ).toThrow('inner');
      tx.kv.set('after', '1');
    });
    expect(s.kv.list().map((e) => e.key)).toEqual(['after', 'outer']);
  });

  it('a unique violation caught inside a transaction keeps the transaction usable', () => {
    const s = openStore();
    s.atomic((tx) => {
      tx.outbox.insert(sampleOutbox({ id: 'o_1', signature: 'sig' }));
      expect(() => tx.outbox.insert(sampleOutbox({ id: 'o_2', signature: 'sig' }))).toThrow(
        UniqueViolationError,
      );
      tx.outbox.insert(sampleOutbox({ id: 'o_3', signature: 'other' }));
    });
    expect(s.outbox.list().map((o) => o.id)).toEqual(['o_1', 'o_3']);
  });

  it('a rejected message insert stores nothing, not even a seq', () => {
    const s = openStore();
    expect(s.messages.insert(msg('m_1', 'c1')).seq).toBe(1);
    expect(() => s.messages.insert(msg('m_2', 'c1'))).toThrow(UniqueViolationError);
    expect(s.messages.insert(msg('m_3', 'c3')).seq).toBe(2);
    expect(s.messages.list().map((m) => m.id)).toEqual(['m_1', 'm_3']);
  });

  it('a second connection sees committed writes only', () => {
    const a = openStore();
    const b = openStore();
    a.atomic((tx) => {
      tx.kv.set('k', '1');
      expect(b.kv.get('k')).toBeUndefined();
    });
    expect(b.kv.get('k')).toBe('1');
  });
});

describe('event.seq', () => {
  it('is strictly increasing and never reused, across rollbacks and reopen', () => {
    const a = openStore();
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) seqs.push(a.events.append(ev(i)).seq);
    expect(() =>
      a.atomic((tx) => {
        tx.events.append(ev(9));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    seqs.push(a.events.append(ev(6)).seq);
    a.close();
    const b = openStore();
    seqs.push(b.events.append(ev(7)).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(b.events.listAfter(5).map((e) => e.seq)).toEqual([6, 7]);
  });
});

describe('unique constraints (enforced by the schema, not only by the repository)', () => {
  const raw = (s: SqliteStore, sql: string, ...params: (string | number | null)[]) =>
    s.connection.prepare(sql).run(...params);
  const constraint = (code: number) => expect.objectContaining({ errcode: code });
  const UNIQUE = 2067;
  const PRIMARY_KEY = 1555;

  it('run.dispatch_id', () => {
    const s = openStore();
    s.projects.insert(sampleProject());
    s.tasks.insert(sampleTask());
    s.workspaces.insert(sampleWorkspace());
    s.runs.insert(sampleRun());
    expect(() =>
      raw(
        s,
        `INSERT INTO run (id, task_id, workspace_id, dispatch_id, kind, role, model_alias, runner,
          model, state, log_dir, started_at) VALUES ('r_2','t_000001','w_000001','d_000001',
          'impl','r','m','dsh','m','starting','/l','${T(0)}')`,
      ),
    ).toThrow(constraint(UNIQUE));
    expect(() => s.runs.insert(sampleRun({ id: 'r_2' }))).toThrow(
      'run with dispatch_id d_000001 already exists',
    );
  });

  it('idempotency primary key (caller, request_id)', () => {
    const s = openStore();
    const insert = () =>
      raw(
        s,
        `INSERT INTO idempotency (caller, request_id, method, payload_hash, state, created_at)
          VALUES ('cli', 'k1', 'POST', 'h', 'pending', '${T(0)}')`,
      );
    insert();
    expect(insert).toThrow(constraint(PRIMARY_KEY));
    raw(
      s,
      `INSERT INTO idempotency (caller, request_id, method, payload_hash, state, created_at)
        VALUES ('web', 'k1', 'POST', 'h', 'pending', '${T(0)}')`,
    );
    expect(s.idempotency.listByState('pending')).toHaveLength(2);
  });

  it('outbox.signature', () => {
    const s = openStore();
    s.outbox.insert(sampleOutbox({ id: 'o_1', signature: 'sig' }));
    expect(() =>
      raw(
        s,
        `INSERT INTO outbox (id, target, kind, body, signature, status, attempts, created_at)
          VALUES ('o_2', 'grok', 'task_done', 'b', 'sig', 'pending', 0, '${T(0)}')`,
      ),
    ).toThrow(constraint(UNIQUE));
  });

  it('message client_msg_id is unique per channel only', () => {
    const s = openStore();
    const insert = (id: string, channel: string, seq: number) =>
      raw(
        s,
        `INSERT INTO message (id, channel, direction, source, body, client_msg_id, status, seq,
          created_at) VALUES (?, ?, 'in', 'cli', 'b', 'c1', 'new', ?, '${T(0)}')`,
        id,
        channel,
        seq,
      );
    insert('m_1', 'leader', 1);
    insert('m_2', 'grok', 2);
    expect(() => insert('m_3', 'leader', 3)).toThrow(constraint(UNIQUE));
  });

  it('effect primary key (kind, key)', () => {
    const s = openStore();
    const insert = (seq: number) =>
      raw(
        s,
        `INSERT INTO effect (kind, key, payload, seq, generation, attempts, due)
          VALUES ('run.start', 'r_1', 'null', ?, 1, 0, '${T(0)}')`,
        seq,
      );
    insert(1);
    expect(() => insert(2)).toThrow(constraint(PRIMARY_KEY));
  });
});

describe('foreign keys and the workspace index (enforced by the schema, docs/adr/0007)', () => {
  const raw = (s: SqliteStore, sql: string) => s.connection.prepare(sql).run();
  const constraint = (code: number) => expect.objectContaining({ errcode: code });
  const FOREIGN_KEY = 787;
  const UNIQUE = 2067;
  const taskRow = (id: string, project: string, extra = '') =>
    `INSERT INTO task (id, project_id, title, tier, ticket_md, owned_paths, priority, status,
      impl_role, fix_rounds, attempts, version, created_at, updated_at${extra ? ', current_run_id' : ''})
      VALUES ('${id}', '${project}', 't', 'C', 'x', '[]', 0, 'queued', 'impl_C', 0, 0, 1,
      '${T(0)}', '${T(0)}'${extra ? `, '${extra}'` : ''})`;
  const workspaceRow = (id: string, task: string, state: string) =>
    `INSERT INTO workspace (id, task_id, path, branch, base_sha, state, created_at)
      VALUES ('${id}', '${task}', '/w/${id}', 'team/x', 'aaaaaaa1', '${state}', '${T(0)}')`;

  it('a raw insert with a missing parent fails with SQLITE_CONSTRAINT_FOREIGNKEY', () => {
    const s = openStore();
    expect(() => raw(s, taskRow('t_1', 'p_404'))).toThrow(constraint(FOREIGN_KEY));
    s.projects.insert(sampleProject());
    raw(s, taskRow('t_1', 'p_000001'));
    expect(() => raw(s, taskRow('t_2', 'p_000001', 'r_404'))).toThrow(constraint(FOREIGN_KEY));
    expect(() => raw(s, workspaceRow('w_1', 't_404', 'active'))).toThrow(constraint(FOREIGN_KEY));
  });

  it('a partial unique index allows one non-removed workspace per task', () => {
    const s = openStore();
    s.projects.insert(sampleProject());
    raw(s, taskRow('t_1', 'p_000001'));
    raw(s, workspaceRow('w_1', 't_1', 'removed'));
    raw(s, workspaceRow('w_2', 't_1', 'removed'));
    raw(s, workspaceRow('w_3', 't_1', 'active'));
    expect(() => raw(s, workspaceRow('w_4', 't_1', 'kept'))).toThrow(constraint(UNIQUE));
    expect(() => s.workspaces.insert(sampleWorkspace({ id: 'w_5', task_id: 't_1' }))).toThrow(
      UniqueViolationError,
    );
  });
});
