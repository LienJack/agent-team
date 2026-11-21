import { describe, expect, it } from 'vitest';
import { UniqueViolationError } from '../../errors.js';
import type { Store } from '../../ports/repositories.js';
import { sampleOutbox } from '../fixtures.js';

const T = (n: number) => `2026-11-21T00:00:0${n}.000Z`;
const HASH = 'a'.repeat(64);

/** outbox, idempotency, kv. */
export function recordContract(store: () => Store): void {
  describe('outbox', () => {
    it('signature is unique; list filters by status and task', () => {
      const s = store();
      s.outbox.insert(
        sampleOutbox({ id: 'o_2', signature: 's2', created_at: T(2), task_id: 't_1' }),
      );
      s.outbox.insert(
        sampleOutbox({ id: 'o_1', signature: 's1', created_at: T(1), status: 'sent' }),
      );
      expect(() => s.outbox.insert(sampleOutbox({ id: 'o_3', signature: 's1' }))).toThrow(
        UniqueViolationError,
      );
      expect(() => s.outbox.insert(sampleOutbox({ id: 'o_1', signature: 'new' }))).toThrow(
        UniqueViolationError,
      );
      expect(s.outbox.findBySignature('s2')?.id).toBe('o_2');
      expect(s.outbox.list().map((o) => o.id)).toEqual(['o_1', 'o_2']);
      expect(s.outbox.list({ statuses: ['pending'] }).map((o) => o.id)).toEqual(['o_2']);
      expect(s.outbox.list({ task_id: 't_1' }).map((o) => o.id)).toEqual(['o_2']);
      const o = s.outbox.get('o_2')!;
      expect(s.outbox.update({ ...o, status: 'sent', attempts: 1, sent_at: T(3) })).toBe(true);
      expect(s.outbox.get('o_2')).toMatchObject({ status: 'sent', attempts: 1, sent_at: T(3) });
    });
  });

  describe('idempotency', () => {
    it('PK (caller, request_id); update, delete, listByState', () => {
      const s = store();
      const rec = {
        caller: 'cli',
        request_id: 'k1',
        method: 'POST /api/tasks',
        payload_hash: HASH,
        state: 'pending' as const,
        response: null,
        created_at: T(1),
      };
      s.idempotency.insert(rec);
      s.idempotency.insert({ ...rec, caller: 'web' });
      expect(() => s.idempotency.insert(rec)).toThrow(UniqueViolationError);
      expect(s.idempotency.get('cli', 'k1')).toEqual(rec);
      expect(s.idempotency.get('cli', 'k2')).toBeUndefined();
      const done = {
        ...rec,
        state: 'completed' as const,
        response: { status: 201, body: { ok: [1] } },
      };
      expect(s.idempotency.update(done)).toBe(true);
      expect(s.idempotency.get('cli', 'k1')).toEqual(done);
      expect(s.idempotency.listByState('pending').map((r) => r.caller)).toEqual(['web']);
      expect(s.idempotency.delete('web', 'k1')).toBe(true);
      expect(s.idempotency.delete('web', 'k1')).toBe(false);
    });
  });

  describe('kv', () => {
    it('set overwrites; list by prefix in key order; delete', () => {
      const s = store();
      s.kv.set('runner_health:dsh', '{"a":1}');
      s.kv.set('runner_health:claude', '{}');
      s.kv.set('leader_session', 'abc');
      s.kv.set('runner_health:dsh', '{"a":2}');
      expect(s.kv.get('runner_health:dsh')).toBe('{"a":2}');
      expect(s.kv.get('missing')).toBeUndefined();
      expect(s.kv.list('runner_health:').map((e) => e.key)).toEqual([
        'runner_health:claude',
        'runner_health:dsh',
      ]);
      expect(s.kv.list()).toHaveLength(3);
      expect(s.kv.delete('leader_session')).toBe(true);
      expect(s.kv.delete('leader_session')).toBe(false);
    });
  });
}
