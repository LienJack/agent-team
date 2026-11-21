import {
  isLiveRunState,
  type EffectRecord,
  type RunResult,
  type RunStartedInfo,
} from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import type { EngineContext, Tx } from './context.js';
import { openAttention } from './attention.js';
import { effectPayload, type EffectFinalizer } from './effect-queue.js';
import { blockTask } from './outcomes.js';
import { finishRun, saveRun } from './records.js';
import { applyRunResult } from './run-result.js';
import { recordRunnerFailure } from './runner-health.js';

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
  const runner = ctx.deps.runners.get(run.runner);
  if (!runner) {
    const result: RunResult = {
      error: { kind: 'crash', message: `runner ${run.runner} is not registered` },
    };
    return (tx) => applyUnstarted(ctx, tx, runId, result);
  }

  const controller = new AbortController();
  ctx.inflight.set(runId, controller);
  let settle!: (signal: StartSignal) => void;
  const startSignal = new Promise<StartSignal>((resolve) => {
    settle = resolve;
  });
  let started = false;

  const completion = runner
    .run(spec, controller.signal, {
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
      if (!started) {
        settle({ started: false, result });
        return;
      }
      if (ctx.stopping) return; // left live on purpose: recovery abandons it on next start
      ctx.transact((tx) => applyRunResult(ctx, tx, runId, result));
    }),
    'run',
  );

  const signal = await startSignal;
  if (signal.started) return (tx) => markAccepted(tx, runId, signal.info);
  if (ctx.stopping) throw new Error('service is shutting down'); // keep the effect for restart
  return (tx) => applyUnstarted(ctx, tx, runId, signal.result);
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
  finishRun(tx, run, {
    state: 'start_unknown',
    outcome: 'error',
    error: `start_unknown: ${result.error.message}`,
  });
  recordRunnerFailure(ctx, tx, run.runner);
  const task = tx.r.tasks.get(run.task_id);
  if (!task || task.current_run_id !== run.id) return;
  blockTask(ctx, tx, task, `無法確認 run ${run.id} 是否已啟動（${result.error.message}）`);
  openAttention(ctx, tx, {
    task_id: task.id,
    kind: 'decision',
    question: `run ${run.id}（${task.title}）是否已啟動無法確認；確認沒有殘留的 worker 後再決定。`,
    options: ['重試', '取消'],
  });
}
