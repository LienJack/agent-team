import {
  isLiveRunState,
  type EffectRecord,
  type RunResult,
  type RunStartedInfo,
} from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import type { EngineContext, Tx } from './context.js';
import { effectPayload, type EffectFinalizer } from './effect-queue.js';
import { saveRun } from './records.js';
import { applyRunResult } from './run-result.js';
import { applyStartUnknown } from './start-unknown.js';

type StartSignal = { started: true; info: RunStartedInfo } | { started: false; result: RunResult };

/**
 * `run.start` effect: launch the run and decide the dispatch outcome (spec §8):
 * - accepted — the runner called `onStarted` (or finished successfully);
 * - unknown  — the runner reported `start_unknown` → run `start_unknown`, task blocked,
 *              attention opened, never resent automatically;
 * - rejected — the runner finished with another error before starting → normal error handling.
 * The effect completes once the outcome is known; the run's completion is handled separately.
 * A leftover effect whose run is no longer `starting`/current (e.g. abandoned during recovery)
 * is dropped without launching anything.
 */
export async function runStartHandler(
  ctx: EngineContext,
  effect: EffectRecord,
): Promise<EffectFinalizer | undefined> {
  const { run_id: runId, spec } = effectPayload(effect, 'run.start');
  const run = ctx.store.runs.get(runId);
  const task = run ? ctx.store.tasks.get(run.task_id) : undefined;
  if (!run || run.state !== 'starting' || !task || task.current_run_id !== run.id) {
    return undefined;
  }
  // never launch the same run twice from this process (e.g. a retried effect)
  if (ctx.inflight.has(runId)) return undefined;
  // shutting down: never spawn a worker that would outlive the service (the run is marked
  // abandoned by the shutdown)
  if (ctx.stopping) return undefined;
  const runner = ctx.deps.runners.get(run.runner);
  if (!runner) {
    const result: RunResult = {
      error: { kind: 'crash', message: `runner ${run.runner} is not registered` },
    };
    return (tx) => applyUnstarted(ctx, tx, runId, result);
  }

  const controller = new AbortController();
  ctx.inflight.set(runId, controller);
  const taskId = run.task_id;
  // no second worker may enter this worktree until this one's runner has resolved
  ctx.workerTasks.set(taskId, (ctx.workerTasks.get(taskId) ?? 0) + 1);
  let settle!: (signal: StartSignal) => void;
  const startSignal = new Promise<StartSignal>((resolve) => {
    settle = resolve;
  });
  let started = false;

  const completion = runner
    .run(spec, controller.signal, {
      // recorded synchronously before the spawn: after a crash, recovery knows a process may
      // exist even if its pid never reached the database (docs/adr/0015)
      onLaunching() {
        recordProcess(ctx, runId, (tx) => ({ launched_at: tx.now }));
      },
      onSpawned(info) {
        recordProcess(ctx, runId, () => ({
          pid: info.pid,
          pid_started_at: info.pidStartedAt ?? null,
        }));
      },
      onStarted(info) {
        if (started) return;
        started = true;
        settle({ started: true, info });
      },
    })
    .catch((err: unknown): RunResult => ({ error: { kind: 'crash', message: errorMessage(err) } }));

  ctx.track(
    completion.then((result) => {
      ctx.inflight.delete(runId);
      const left = (ctx.workerTasks.get(taskId) ?? 1) - 1;
      if (left > 0) ctx.workerTasks.set(taskId, left);
      else ctx.workerTasks.delete(taskId);
      if (left <= 0) ctx.onCommit?.(); // the task may be dispatched again
      if (!started) {
        settle({ started: false, result });
        return;
      }
      if (ctx.stopping) return; // not applied: the shutdown marks the run abandoned
      ctx.transact((tx) => applyRunResult(ctx, tx, runId, result));
    }),
    'run',
  );

  const signal = await startSignal;
  if (signal.started) return (tx) => markAccepted(tx, runId, signal.info);
  // keep the effect; the shutdown marks the run abandoned, so a restart drops it as a no-op
  if (ctx.stopping) throw new Error('service is shutting down');
  return (tx) => applyUnstarted(ctx, tx, runId, signal.result);
}

/** Store process facts of a run (no state change, no event); never throws into the runner. */
function recordProcess(
  ctx: EngineContext,
  runId: string,
  patch: (tx: Tx) => { launched_at?: string; pid?: number; pid_started_at?: string | null },
): void {
  try {
    ctx.transact((tx) => {
      const run = tx.r.runs.get(runId);
      if (run) saveRun(tx, run, patch(tx));
    });
  } catch (err) {
    ctx.logger.error('cannot record worker process', { run_id: runId, error: errorMessage(err) });
  }
}

function markAccepted(tx: Tx, runId: string, info: RunStartedInfo): void {
  const run = tx.r.runs.get(runId);
  if (!run) return;
  tx.emit(
    'run.dispatched',
    { outcome: 'accepted', reason: null },
    { task_id: run.task_id, run_id: run.id },
  );
  // the result may already have been applied (fast runner); only a starting run moves on
  if (run.state !== 'starting') return;
  saveRun(tx, run, {
    state: 'running',
    pid: info.pid ?? run.pid,
    pid_started_at: info.pidStartedAt ?? run.pid_started_at,
    session_ref: info.sessionRef ?? run.session_ref,
  });
}

/** The runner resolved without ever reporting "started". */
function applyUnstarted(ctx: EngineContext, tx: Tx, runId: string, result: RunResult): void {
  const run = tx.r.runs.get(runId);
  if (!run || !isLiveRunState(run.state)) return;
  const refs = { task_id: run.task_id, run_id: run.id };

  if (!result.error) {
    tx.emit('run.dispatched', { outcome: 'accepted', reason: null }, refs);
    applyRunResult(ctx, tx, runId, result);
    return;
  }
  if (result.error.kind !== 'start_unknown') {
    tx.emit('run.dispatched', { outcome: 'rejected', reason: result.error.message }, refs);
    applyRunResult(ctx, tx, runId, result);
    return;
  }

  tx.emit('run.dispatched', { outcome: 'unknown', reason: result.error.message }, refs);
  applyStartUnknown(ctx, tx, run, result.error.message);
}
