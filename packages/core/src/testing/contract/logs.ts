import type { NewEvent, NewMessage } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { UniqueViolationError } from '../../errors.js';
import type { Store } from '../../ports/repositories.js';
import { sampleAttention } from '../fixtures.js';

const T = (n: number) => `2026-11-21T00:00:${String(n).padStart(2, '0')}.000Z`;

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm_1',
    channel: 'leader',
    direction: 'in',
    source: 'web',
    body: '你好',
    client_msg_id: 'c1',
    ref: null,
    status: 'new',
    created_at: T(0),
    ...overrides,
  };
}

function ev(n: number, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    ts: T(n),
    type: 'task.status_changed',
    data: { from: 'queued', to: 'running', reason: null },
    task_id: 't_1',
    run_id: null,
    ...overrides,
  } as NewEvent;
}

/** attention, messages, events, effects. */
export function logContract(store: () => Store): void {
  describe('attention', () => {
    it('insert, filter, update, unique id', () => {
      const s = store();
      s.attention.insert(sampleAttention({ id: 'a_2', created_at: T(2), task_id: 't_1' }));
      s.attention.insert(sampleAttention({ id: 'a_1', created_at: T(1), status: 'answered' }));
      expect(s.attention.list().map((a) => a.id)).toEqual(['a_1', 'a_2']);
      expect(s.attention.list({ statuses: ['open'] }).map((a) => a.id)).toEqual(['a_2']);
      expect(s.attention.list({ task_id: 't_1' }).map((a) => a.id)).toEqual(['a_2']);
      const a = s.attention.get('a_2')!;
      expect(
        s.attention.update({
          ...a,
          status: 'answered',
          answer: 'A',
          answered_via: 'cli',
          answered_at: T(3),
        }),
      ).toBe(true);
      expect(s.attention.get('a_2')).toMatchObject({
        status: 'answered',
        answer: 'A',
        options: ['A', 'B'],
      });
      expect(() => s.attention.insert(sampleAttention({ id: 'a_1' }))).toThrow(
        UniqueViolationError,
      );
    });
  });

  describe('messages', () => {
    it('assign increasing seq and dedupe by (channel, client_msg_id)', () => {
      const s = store();
      const m1 = s.messages.insert(msg());
      const m2 = s.messages.insert(msg({ id: 'm_2', client_msg_id: 'c2' }));
      const m3 = s.messages.insert(msg({ id: 'm_3', channel: 'grok', client_msg_id: 'c1' }));
      expect(m1.seq).toBeLessThan(m2.seq);
      expect(m2.seq).toBeLessThan(m3.seq);
      expect(() => s.messages.insert(msg({ id: 'm_4' }))).toThrow(UniqueViolationError);
      expect(() => s.messages.insert(msg({ client_msg_id: 'other' }))).toThrow(
        UniqueViolationError,
      );
      expect(s.messages.findByClientMsgId('grok', 'c1')?.id).toBe('m_3');
      expect(s.messages.findByClientMsgId('leader', 'nope')).toBeUndefined();
    });

    it('list by channel, after seq, with limit; update status', () => {
      const s = store();
      const a = s.messages.insert(msg());
      s.messages.insert(msg({ id: 'm_2', client_msg_id: 'c2' }));
      s.messages.insert(msg({ id: 'm_3', channel: 'grok', client_msg_id: 'g' }));
      s.messages.insert(msg({ id: 'm_4', client_msg_id: 'c4' }));
      expect(s.messages.list({ channel: 'leader' }).map((m) => m.id)).toEqual([
        'm_1',
        'm_2',
        'm_4',
      ]);
      expect(s.messages.list({ afterSeq: a.seq, limit: 2 }).map((m) => m.id)).toEqual([
        'm_2',
        'm_3',
      ]);
      expect(s.messages.update({ ...a, status: 'acked' })).toBe(true);
      expect(s.messages.get('m_1')?.status).toBe('acked');
    });
  });

  describe('events', () => {
    it('append assigns seq 1, 2, 3 and lists after a cursor', () => {
      const s = store();
      expect(s.events.lastSeq()).toBe(0);
      const e1 = s.events.append(ev(1));
      const e2 = s.events.append(
        ev(2, { type: 'runner.circuit_closed', data: { runner: 'dsh' } } as Partial<NewEvent>),
      );
      const e3 = s.events.append(ev(3, { task_id: null, run_id: 'r_1' }));
      expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
      expect(s.events.lastSeq()).toBe(3);
      expect(s.events.listAfter(1).map((e) => e.seq)).toEqual([2, 3]);
      expect(s.events.listAfter(0, 2).map((e) => e.seq)).toEqual([1, 2]);
      expect(s.events.listAfter(3)).toEqual([]);
      expect(s.events.listAfter(0)[1]).toEqual({
        ...ev(2),
        type: 'runner.circuit_closed',
        data: { runner: 'dsh' },
        seq: 2,
      });
      expect(s.events.listAfter(2)[0]).toMatchObject({ task_id: null, run_id: 'r_1' });
    });
  });

  describe('effects', () => {
    it('upsert creates with seq and generation 1, re-upsert bumps generation and keeps seq', () => {
      const s = store();
      const a = s.effects.upsert({ kind: 'run.start', key: 'r_1', payload: { n: 1 }, due: T(0) });
      const b = s.effects.upsert({ kind: 'outbox.send', key: 'o_1', payload: null, due: T(0) });
      expect(a).toMatchObject({ generation: 1, attempts: 0, error: null });
      expect(b.seq).toBeGreaterThan(a.seq);
      s.effects.recordFailure('run.start', 'r_1', 1, { attempts: 2, due: T(9), error: 'x' });
      const again = s.effects.upsert({
        kind: 'run.start',
        key: 'r_1',
        payload: { n: 2 },
        due: T(1),
      });
      expect(again).toMatchObject({
        seq: a.seq,
        generation: 2,
        attempts: 0,
        error: null,
        due: T(1),
      });
      expect(s.effects.get('run.start', 'r_1')?.payload).toEqual({ n: 2 });
      expect(s.effects.list().map((e) => e.key)).toEqual(['r_1', 'o_1']);
    });

    it('same key under different kinds are different effects', () => {
      const s = store();
      s.effects.upsert({ kind: 'run.start', key: 'k', payload: 1, due: T(0) });
      s.effects.upsert({ kind: 'run.stop', key: 'k', payload: 2, due: T(0) });
      expect(s.effects.list()).toHaveLength(2);
    });

    it('listDue filters by due and orders by seq', () => {
      const s = store();
      s.effects.upsert({ kind: 'run.start', key: 'late', payload: null, due: T(30) });
      s.effects.upsert({ kind: 'run.start', key: 'now', payload: null, due: T(10) });
      s.effects.upsert({ kind: 'run.verify', key: 'early', payload: null, due: T(5) });
      expect(s.effects.listDue(T(10)).map((e) => e.key)).toEqual(['now', 'early']);
      expect(s.effects.listDue(T(10), 1).map((e) => e.key)).toEqual(['now']);
      expect(s.effects.listDue(T(4))).toEqual([]);
    });

    it('delete and recordFailure only apply to the matching generation', () => {
      const s = store();
      s.effects.upsert({ kind: 'run.verify', key: 'r_1', payload: null, due: T(0) });
      s.effects.upsert({ kind: 'run.verify', key: 'r_1', payload: null, due: T(0) }); // gen 2
      expect(s.effects.delete('run.verify', 'r_1', 1)).toBe(false);
      expect(
        s.effects.recordFailure('run.verify', 'r_1', 1, { attempts: 1, due: T(5), error: 'stale' }),
      ).toBeUndefined();
      const failed = s.effects.recordFailure('run.verify', 'r_1', 2, {
        attempts: 1,
        due: T(5),
        error: 'boom',
      });
      expect(failed).toMatchObject({ attempts: 1, due: T(5), error: 'boom', generation: 2 });
      expect(s.effects.delete('run.verify', 'r_1', 2)).toBe(true);
      expect(s.effects.get('run.verify', 'r_1')).toBeUndefined();
      expect(s.effects.delete('run.verify', 'r_1', 2)).toBe(false);
    });
  });
}
