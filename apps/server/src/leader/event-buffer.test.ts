import type { EventRecord } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { EventBuffer } from './event-buffer.js';

// Validation 2026-11-21 scenario 6: three tasks finishing 4 s and 15 s apart gave the leader three
// digests (three model turns). The digest now waits for a quiet window.

const done = (seq: number, task: string): EventRecord =>
  ({
    seq,
    ts: '2026-11-21T00:00:00.000Z',
    type: 'task.status_changed',
    task_id: task,
    run_id: null,
    data: { from: 'review', to: 'done', reason: null },
  }) as EventRecord;

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('leader event digest coalescing', () => {
  it('three near-simultaneous completions → one digest', () => {
    const c = clock();
    const buffer = new EventBuffer(5000, { maxWaitMs: 60_000, maxBatch: 30, now: c.now });
    const all = () => true;
    buffer.add([done(1, 't_a')], all);
    c.advance(4000);
    buffer.add([done(2, 't_b')], all);
    expect(buffer.waitMs()).toBe(5000); // quiet window restarts with every event
    c.advance(4500);
    buffer.add([done(3, 't_c')], all);
    c.advance(4999);
    expect(buffer.waitMs()).toBe(1);
    c.advance(1);
    expect(buffer.waitMs()).toBe(0);
    expect(buffer.take().map((e) => e.task_id)).toEqual(['t_a', 't_b', 't_c']);
    expect(buffer.size).toBe(0);
  });

  it('never waits longer than maxWaitMs after the oldest event', () => {
    const c = clock();
    const buffer = new EventBuffer(5000, { maxWaitMs: 12_000, now: c.now });
    for (let i = 0; i < 5; i++) {
      buffer.add([done(i + 1, `t_${i}`)], () => true);
      c.advance(3000); // a steady trickle would otherwise postpone it forever
    }
    expect(buffer.waitMs()).toBe(0);
  });

  it('takes at most maxBatch events; a full batch is due at once and the rest right after', () => {
    const c = clock();
    const buffer = new EventBuffer(5000, { maxWaitMs: 60_000, maxBatch: 2, now: c.now });
    buffer.add([done(1, 't_a'), done(2, 't_b'), done(3, 't_c')], () => true);
    expect(buffer.waitMs()).toBe(0);
    expect(buffer.take()).toHaveLength(2);
    expect(buffer.size).toBe(1);
    expect(buffer.waitMs()).toBe(0);
    expect(buffer.take().map((e) => e.task_id)).toEqual(['t_c']);
  });
});
