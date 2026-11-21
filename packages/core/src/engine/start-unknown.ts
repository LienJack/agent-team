import type { Run } from '@agent-team/schema';
import type { EngineContext, Tx } from './context.js';
import { openAttention } from './attention.js';
import { blockTask } from './outcomes.js';
import { finishRun } from './records.js';
import { recordRunnerFailure } from './runner-health.js';

/**
 * A runner could not tell whether the agent started (docs/adr/0010, spec §8 `unknown`): the run
 * ends (`start_unknown` while still `starting`; `failed` if it was already marked running), the
 * task is blocked and one attention item asks a human. Never resent automatically: a second
 * worker could otherwise edit the same worktree as an orphaned first one.
 */
export function applyStartUnknown(ctx: EngineContext, tx: Tx, run: Run, message: string): void {
  finishRun(tx, run, {
    state: run.state === 'starting' ? 'start_unknown' : 'failed',
    outcome: 'error',
    error: `start_unknown: ${message}`,
  });
  recordRunnerFailure(ctx, tx, run.runner);
  const task = tx.r.tasks.get(run.task_id);
  if (!task || task.current_run_id !== run.id) return;
  blockTask(ctx, tx, task, `無法確認 run ${run.id} 是否已啟動（${message}）`);
  openAttention(ctx, tx, {
    task_id: task.id,
    kind: 'decision',
    question: `run ${run.id}（${task.title}）是否已啟動無法確認；確認沒有殘留的 worker 後再決定。`,
    options: ['重試', '取消'],
  });
}

/** Run error of a worker that recovery could not confirm dead (docs/adr/0015). */
export const WORKER_UNCONFIRMED = 'abandoned: worker may still be running';
/** Prefix of `blocked_reason` when recovery could not confirm a worker dead (human retry only). */
export const WORKER_UNCONFIRMED_BLOCK = 'worker_unconfirmed:';

/**
 * Why only a human may retry after `run` (its worker may still be alive), or null. Covers
 * `start_unknown` (before or after `onStarted`) and workers recovery could not confirm dead.
 */
export function needsHumanRetry(run: Run | undefined): string | null {
  if (!run) return null;
  if (run.state === 'start_unknown' || (run.error ?? '').startsWith('start_unknown')) {
    return 'its last run may have started (start_unknown)';
  }
  if ((run.error ?? '').startsWith(WORKER_UNCONFIRMED)) {
    return 'its last worker could not be confirmed dead after a restart';
  }
  return null;
}
