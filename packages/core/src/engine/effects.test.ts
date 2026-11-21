import type { EffectRecord } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';
import { enqueueEffect, type EffectHandler } from './effect-queue.js';
import { EFFECT_HANDLERS, EffectExecutor } from './effects.js';

/** A harness whose engine never wakes itself, so a hand-built executor is the only one running. */
function isolated() {
  const h = createTestEngine();
  h.engine.ctx.onCommit = undefined;
  return h;
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('§14 effect 的重試與世代 — store first, then execute', () => {
  it('an effect is written in the same transaction as the state change and deleted after it ran', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({ hold: true });
    const task = h.task();
    await h.engine.tick();
    // run.start was stored with the dispatch, and removed once the runner accepted
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    await h.engine.drain();
    expect(h.store.effects.get('run.start', run.id)).toBeUndefined();
    h.engine.cancelTask(task.id);
    expect(h.store.effects.get('run.stop', run.id)).toMatchObject({ generation: 1, attempts: 0 });
    await h.engine.runUntilIdle();
    expect(h.store.effects.list()).toEqual([]);
    expect(h.runners.dsh.held()).toEqual([]);
  });

  it('a failing effect is retried with exponential backoff and its error recorded', async () => {
    const h = createTestEngine();
    h.notifier.failNext(2);
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.task();
    await h.engine.runUntilIdle();
    const [effect] = h.store.effects.list();
    expect(effect).toMatchObject({
      kind: 'outbox.send',
      attempts: 1,
      error: 'grokmsg unavailable',
      due: '2026-11-21T00:00:05.000Z',
    });
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.store.effects.list()[0]).toMatchObject({
      attempts: 2,
      due: '2026-11-21T00:00:15.000Z',
    });
    h.clock.advance(10000);
    await h.engine.runUntilIdle();
    expect(h.store.effects.list()).toEqual([]);
    expect(h.store.outbox.list()[0]).toMatchObject({ status: 'sent', attempts: 3 });
    const failures = h.store.events.listAfter(0).filter((e) => e.type === 'effect.failed');
    expect(failures.map((e) => (e.data as { attempts: number }).attempts)).toEqual([1, 2]);
  });

  it('gives up after effect_max_attempts: effect.dead and the handler’s onDead (outbox failed)', async () => {
    const h = createTestEngine({
      config: { engine: { ...createTestEngine().config.engine, effect_max_attempts: 2 } },
    });
    h.notifier.failNext(10);
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.task();
    await h.engine.runUntilIdle();
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.store.effects.list()).toEqual([]);
    expect(h.store.outbox.list()[0]).toMatchObject({
      status: 'failed',
      error: 'grokmsg unavailable',
    });
    expect(h.eventTypes()).toEqual(expect.arrayContaining(['effect.dead', 'outbox.failed']));
  });

  it('a newer generation enqueued while the old one runs survives the old completion', async () => {
    const h = isolated();
    const g = gate();
    const seen: number[] = [];
    const handler: EffectHandler = {
      async run(_ctx, effect: EffectRecord) {
        seen.push(effect.generation);
        if (effect.generation === 1) await g.promise;
        return undefined;
      },
    };
    const exec = new EffectExecutor(h.engine.ctx, { ...EFFECT_HANDLERS, 'run.stop': handler });
    h.engine.ctx.transact((tx) =>
      enqueueEffect(tx, 'run.stop', 'r_x', { run_id: 'r_000001', reason: 'a' }),
    );
    expect(exec.runDue()).toBe(1);
    // re-enqueue the same key while generation 1 executes
    h.engine.ctx.transact((tx) =>
      enqueueEffect(tx, 'run.stop', 'r_x', { run_id: 'r_000001', reason: 'b' }),
    );
    expect(exec.runDue()).toBe(0); // same lane is busy
    g.open();
    await Promise.allSettled(h.engine.ctx.work);
    const survivor = h.store.effects.get('run.stop', 'r_x');
    expect(survivor).toMatchObject({ generation: 2, payload: { reason: 'b' } });
    expect(exec.runDue()).toBe(1);
    await Promise.allSettled(h.engine.ctx.work);
    expect(seen).toEqual([1, 2]);
    expect(h.store.effects.get('run.stop', 'r_x')).toBeUndefined();
  });

  it('effects in one lane run in seq order, even when an earlier one is backing off', async () => {
    const h = isolated();
    const order: string[] = [];
    let failFirst = true;
    const handler: EffectHandler = {
      async run(_ctx, effect) {
        if (effect.key === 'o_1' && failFirst) {
          failFirst = false;
          throw new Error('down');
        }
        order.push(effect.key);
        return undefined;
      },
    };
    const exec = new EffectExecutor(h.engine.ctx, { ...EFFECT_HANDLERS, 'outbox.send': handler });
    h.engine.ctx.transact((tx) => {
      enqueueEffect(tx, 'outbox.send', 'o_1', { outbox_id: 'o_000001', task_id: 't_1' });
      enqueueEffect(tx, 'outbox.send', 'o_2', { outbox_id: 'o_000002', task_id: 't_1' });
      enqueueEffect(tx, 'outbox.send', 'o_3', { outbox_id: 'o_000003', task_id: 't_2' });
    });
    exec.runDue();
    await Promise.allSettled(h.engine.ctx.work);
    exec.runDue(); // o_1 is backing off: o_2 (same task) must wait, o_3 already ran
    await Promise.allSettled(h.engine.ctx.work);
    expect(order).toEqual(['o_3']);
    h.clock.advance(5000);
    exec.runDue();
    await Promise.allSettled(h.engine.ctx.work);
    exec.runDue();
    await Promise.allSettled(h.engine.ctx.work);
    expect(order).toEqual(['o_3', 'o_1', 'o_2']);
  });

  it('a handler that throws in its finalizer is retried, not lost', async () => {
    const h = isolated();
    let calls = 0;
    const handler: EffectHandler = {
      async run() {
        calls++;
        return () => {
          if (calls === 1) throw new Error('finalizer conflict');
        };
      },
    };
    const exec = new EffectExecutor(h.engine.ctx, { ...EFFECT_HANDLERS, 'run.verify': handler });
    h.engine.ctx.transact((tx) => enqueueEffect(tx, 'run.verify', 'r_v', { run_id: 'r_000001' }));
    exec.runDue();
    await Promise.allSettled(h.engine.ctx.work);
    expect(h.store.effects.get('run.verify', 'r_v')).toMatchObject({
      attempts: 1,
      error: 'finalizer conflict',
    });
    h.clock.advance(5000);
    exec.runDue();
    await Promise.allSettled(h.engine.ctx.work);
    expect(h.store.effects.get('run.verify', 'r_v')).toBeUndefined();
  });
});
