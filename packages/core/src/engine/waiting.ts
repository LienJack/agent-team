import type { TaskWaiting } from '@agent-team/schema';
import type { EngineContext } from './context.js';
import type { Deferred, DeferReason } from './scheduler.js';

// `task.waiting` (validation 2026-11-21: a task deferred for an owned_paths overlap sat in 待派
// with no explanation). After each scheduling pass the engine knows why every waiting task was not
// dispatched; it keeps that per task in memory (the board card shows it) and emits an event when
// the reason changes — throttled to one event per task every WAITING_EVENT_MIN_MS, so a reason
// that flips between passes cannot flood the log or wake ticks in a loop (an unchanged reason
// emits nothing, so its commit never wakes another pass). After a restart the first pass
// rebuilds the state.

export const WAITING_EVENT_MIN_MS = 30_000;

export type WaitingEntry = TaskWaiting & { since: string };

export interface WaitingState {
  /** What the card shows: the current reason, `since` = when it started. */
  shown: WaitingEntry;
  /** Identity of the last emitted reason, and when it was emitted. */
  emittedKey: string | null;
  emittedAt: number;
}

const REASON: Record<DeferReason, TaskWaiting['reason']> = {
  global_cap: 'no_slot',
  role_slots: 'no_slot',
  path_overlap: 'path_overlap',
  no_model: 'runner_cooldown',
  unknown_role: 'no_slot',
  backoff: 'backoff',
  worker_alive: 'worker_alive',
};

function toWaiting(d: Deferred): TaskWaiting {
  return {
    reason: REASON[d.reason],
    detail:
      d.detail ??
      (d.reason === 'global_cap'
        ? 'max_concurrent_runs reached'
        : d.reason === 'path_overlap' && d.blocking_task_id === ''
          ? 'overlaps a task being dispatched'
          : null),
    blocking_task_id: d.blocking_task_id ? d.blocking_task_id : null,
    retry_at: d.retry_at,
  };
}

const keyOf = (w: TaskWaiting) => `${w.reason}|${w.blocking_task_id ?? ''}|${w.detail ?? ''}`;

/** Record this pass's reasons; emit `task.waiting` for changed ones (throttled). */
export function trackWaiting(
  ctx: EngineContext,
  deferred: readonly Deferred[],
  blocked: ReadonlyArray<{ task_id: string; reason: string }>,
): void {
  const now = ctx.now();
  const nowMs = now.getTime();
  const current = new Map<string, TaskWaiting>();
  for (const d of deferred) current.set(d.task_id, toWaiting(d));
  for (const b of blocked) {
    if (b.reason !== 'base_drift') continue;
    current.set(b.task_id, {
      reason: 'base_drift',
      detail: 'the base branch moved under owned_paths; answer the attention item',
      blocking_task_id: null,
      retry_at: null,
    });
  }
  // tasks that are not waiting any more (dispatched, cancelled, …) forget their reason
  for (const id of ctx.waiting.keys()) if (!current.has(id)) ctx.waiting.delete(id);

  const due: Array<[string, TaskWaiting]> = [];
  for (const [taskId, waiting] of current) {
    const key = keyOf(waiting);
    const prev = ctx.waiting.get(taskId);
    const since = prev && keyOf(prev.shown) === key ? prev.shown.since : now.toISOString();
    const state: WaitingState = prev ?? {
      shown: { ...waiting, since },
      emittedKey: null,
      emittedAt: 0,
    };
    state.shown = { ...waiting, since };
    ctx.waiting.set(taskId, state);
    if (state.emittedKey === key) continue;
    if (state.emittedKey !== null && nowMs - state.emittedAt < WAITING_EVENT_MIN_MS) continue;
    due.push([taskId, waiting]);
  }
  if (due.length === 0) return;
  ctx.transact((tx) => {
    for (const [taskId, waiting] of due) {
      if (!tx.r.tasks.get(taskId)) continue;
      tx.emit('task.waiting', waiting, { task_id: taskId });
      const state = ctx.waiting.get(taskId)!;
      state.emittedKey = keyOf(waiting);
      state.emittedAt = nowMs;
    }
  });
}
