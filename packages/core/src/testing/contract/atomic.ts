import type { NewEvent } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import type { Store } from '../../ports/repositories.js';
import { sampleProject, sampleTask } from '../fixtures.js';

const event = {
  ts: '2026-11-21T00:00:00.000Z',
  type: 'project.created',
  data: { name: 'x' },
  task_id: null,
  run_id: null,
} as NewEvent;

/** Transactions: commit, rollback across every repository, sync-only, nesting. */
export function atomicContract(store: () => Store): void {
  describe('atomic()', () => {
    it('returns the callback result and commits all writes', () => {
      const s = store();
      const out = s.atomic((tx) => {
        tx.projects.insert(sampleProject());
        tx.tasks.insert(sampleTask());
        tx.events.append(event);
        return 42;
      });
      expect(out).toBe(42);
      expect(s.projects.list()).toHaveLength(1);
      expect(s.tasks.list()).toHaveLength(1);
      expect(s.events.lastSeq()).toBe(1);
    });

    it('rolls back every repository when the callback throws', () => {
      const s = store();
      s.projects.insert(sampleProject());
      s.tasks.insert(sampleTask());
      s.events.append(event);
      const boom = new Error('boom');
      expect(() =>
        s.atomic((tx) => {
          const t = tx.tasks.get('t_000001')!;
          tx.tasks.update({ ...t, status: 'running' }, t.version);
          tx.projects.insert(sampleProject({ id: 'p_2', name: 'other' }));
          tx.events.append(event);
          tx.effects.upsert({ kind: 'run.start', key: 'r_1', payload: null, due: event.ts });
          tx.outbox.insert({
            id: 'o_1',
            target: 'grok',
            kind: 'task_done',
            body: 'x',
            signature: 'sig',
            status: 'pending',
            task_id: null,
            attempts: 0,
            error: null,
            created_at: event.ts,
            sent_at: null,
          });
          tx.kv.set('k', 'v');
          tx.messages.insert({
            id: 'm_1',
            channel: 'leader',
            direction: 'in',
            source: 'cli',
            body: 'hi',
            client_msg_id: 'c',
            ref: null,
            status: 'new',
            created_at: event.ts,
          });
          throw boom;
        }),
      ).toThrow(boom);
      expect(s.tasks.get('t_000001')).toMatchObject({ status: 'queued', version: 1 });
      expect(s.projects.list().map((p) => p.id)).toEqual(['p_000001']);
      expect(s.events.lastSeq()).toBe(1);
      expect(s.effects.list()).toEqual([]);
      expect(s.outbox.list()).toEqual([]);
      expect(s.kv.get('k')).toBeUndefined();
      expect(s.messages.list()).toEqual([]);
      // sequences continue without reusing committed values
      expect(s.events.append(event).seq).toBe(2);
    });

    it('rejects an async callback and keeps nothing it wrote', () => {
      const s = store();
      const attempt = () =>
        s.atomic((tx) => {
          tx.kv.set('async', '1');
          return Promise.resolve(1);
        });
      // the message is implementation-defined; only the throw and the rollback are contract
      // oxlint-disable-next-line vitest/require-to-throw-message
      expect(attempt).toThrow();
      expect(s.kv.get('async')).toBeUndefined();
    });

    it('nested atomic joins the outer transaction', () => {
      const s = store();
      expect(() =>
        s.atomic((tx) => {
          s.atomic((inner) => inner.kv.set('inner', '1'));
          tx.kv.set('outer', '1');
          throw new Error('outer fails');
        }),
      ).toThrow('outer fails');
      expect(s.kv.get('inner')).toBeUndefined();
      expect(s.kv.get('outer')).toBeUndefined();
      s.atomic(() => s.atomic((inner) => inner.kv.set('both', '1')));
      expect(s.kv.get('both')).toBe('1');
    });

    it('a failed optimistic update inside a transaction leaves the row untouched', () => {
      const s = store();
      s.projects.insert(sampleProject());
      s.tasks.insert(sampleTask());
      const result = s.atomic((tx) => tx.tasks.update(sampleTask({ status: 'done' }), 7));
      expect(result).toBeUndefined();
      expect(s.tasks.get('t_000001')?.status).toBe('queued');
    });
  });
}
