import { defaultServiceConfig } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';
import { WAITING_EVENT_MIN_MS } from './waiting.js';

// Validation 2026-11-21 scenario 6: `alpha half()` waited 24 s for `alpha double()` (same file)
// and nothing said why. Now the engine emits `task.waiting` and the board shows the reason.

const waitingEvents = (h: ReturnType<typeof createTestEngine>, taskId: string) =>
  h.store.events.listAfter(0).filter((e) => e.type === 'task.waiting' && e.task_id === taskId);

describe('task.waiting', () => {
  it('names the overlapping task once, not on every pass, and is gone once dispatched', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts'], { hold: true }));
    const first = h.task({ owned_paths: ['src/feature/a.ts'] });
    await h.engine.drain();
    const second = h.task({ owned_paths: ['src/feature/a.ts'], title: 'second' });
    for (let i = 0; i < 3; i++) {
      await h.engine.tick();
      h.clock.advance(5000);
    }
    const events = waitingEvents(h, second.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      reason: 'path_overlap',
      detail: null,
      blocking_task_id: first.id,
      retry_at: null,
    });
    expect(h.engine.waitingOf(second.id)).toMatchObject({
      reason: 'path_overlap',
      blocking_task_id: first.id,
    });
    // the first task finishes; the second is dispatched and has no waiting reason any more
    h.runners.dsh.release();
    await h.engine.runUntilIdle();
    expect(h.get(first.id).status).toBe('done');
    expect(h.store.runs.list({ task_id: second.id }).length).toBeGreaterThan(0);
    expect(h.engine.waitingOf(second.id)).toBeNull();
  });

  it('a changed reason is emitted at most once per task every 30 s', async () => {
    const engine = { ...defaultServiceConfig().engine, max_concurrent_runs: 2 };
    const h = createTestEngine({ config: { engine: { ...engine, reserved_human_slots: 1 } } });
    h.runners.dsh.defaultStep = { hold: true };
    h.task({ owned_paths: ['src/one.ts'] }); // takes the only non-human slot
    await h.engine.drain();
    const waiting = h.task({ owned_paths: ['src/two.ts'] });
    await h.engine.tick();
    expect(waitingEvents(h, waiting.id).map((e) => e.data)).toEqual([
      {
        reason: 'no_slot',
        detail: 'max_concurrent_runs reached',
        blocking_task_id: null,
        retry_at: null,
      },
    ]);
    // the reason changes right away (a failure backoff), but the event waits for the window
    h.store.atomic((r) => {
      const t = r.tasks.get(waiting.id)!;
      r.tasks.update(
        { ...t, retry_at: new Date(h.clock.now().getTime() + 60_000).toISOString() },
        t.version,
      );
    });
    await h.engine.tick();
    expect(waitingEvents(h, waiting.id)).toHaveLength(1);
    expect(h.engine.waitingOf(waiting.id)?.reason).toBe('backoff'); // the card is current
    h.clock.advance(WAITING_EVENT_MIN_MS);
    await h.engine.tick();
    expect(waitingEvents(h, waiting.id).map((e) => (e.data as { reason: string }).reason)).toEqual([
      'no_slot',
      'backoff',
    ]);
  });
});
