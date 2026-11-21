import {
  isLiveRunState,
  parseReceipt,
  type ImplReceipt,
  type ReviewReceipt,
  type Run,
  type RunOutcome,
  type RunResult,
  type RunState,
  type Task,
} from '@agent-team/schema';
import type { EngineContext, Tx } from './context.js';
import { openAttention } from './attention.js';
import { enqueueEffect } from './effect-queue.js';
import { notify } from './notify.js';
import { blockTask, completeTask, requestFix, retryLater } from './outcomes.js';
import { finishRun, saveTask } from './records.js';
import {
  recordQuota,
  recordRunnerFailure,
  recordRunnerSuccess,
  startCooldown,
} from './runner-health.js';
import { applyStartUnknown } from './start-unknown.js';

// Applying a runner's result (spec §6 step 1–2, §8 errors). Synchronous, inside one transaction.

function classifyError(kind: NonNullable<RunResult['error']>['kind']): {
  state: RunState;
  outcome: RunOutcome;
} {
  switch (kind) {
    case 'cancelled':
      return { state: 'stopped', outcome: 'cancelled' };
    case 'rate_limit':
      return { state: 'failed', outcome: 'rate_limited' };
    case 'timeout':
      return { state: 'failed', outcome: 'timeout' };
    default:
      return { state: 'failed', outcome: 'error' };
  }
}

function resultFields(run: Run, result: RunResult) {
  return {
    usage: result.usage ?? run.usage,
    cost_usd: result.costUsd ?? run.cost_usd,
    session_ref: result.sessionRef ?? run.session_ref,
  };
}

/**
 * Apply `result` to run `runId`. Results for runs that are no longer live are ignored; results
 * of a live run that is no longer the task's current run (fenced off by `current_run_id`) are
 * recorded on the run only and never change the task.
 */
export function applyRunResult(ctx: EngineContext, tx: Tx, runId: string, result: RunResult): void {
  const run = tx.r.runs.get(runId);
  if (!run || !isLiveRunState(run.state)) return;
  const task = tx.r.tasks.get(run.task_id);
  const isCurrent = task !== undefined && task.current_run_id === run.id;
  if (result.quota) recordQuota(ctx, tx, run.runner, result.quota);

  if (result.error) {
    const { kind, message } = result.error;
    // runners report it only before onStarted; whenever it arrives, it is never resent
    if (kind === 'start_unknown') {
      applyStartUnknown(ctx, tx, run, message);
      return;
    }
    const { state, outcome } = classifyError(kind);
    finishRun(tx, run, {
      ...resultFields(run, result),
      state,
      outcome,
      error: `${kind}: ${message}`,
    });
    if (kind === 'rate_limit') {
      startCooldown(ctx, tx, run.runner, result.quota?.resetsAt, `rate limit (run ${run.id})`);
    } else if (kind !== 'cancelled') {
      recordRunnerFailure(ctx, tx, run.runner);
    }
    if (kind === 'bad_output') notifyNoReceipt(ctx, tx, run, task, message);
    if (!isCurrent || !task) return;
    retryLater(ctx, tx, task, run.kind, {
      countAttempt: kind !== 'rate_limit',
      reason: `${run.kind} run ${run.id} ${kind}: ${message}`,
    });
    return;
  }

  recordRunnerSuccess(tx, run.runner);
  if (!isCurrent || !task) {
    finishRun(tx, run, {
      ...resultFields(run, result),
      state: 'succeeded',
      outcome: 'rejected',
      reject_reason: 'stale_dispatch: run is no longer the task’s current run',
    });
    return;
  }

  const kind = run.kind === 'review' ? 'review' : 'impl';
  const parsed = parseReceipt(kind, result.final);
  const problem = !parsed.ok
    ? `invalid_receipt: ${parsed.error}`
    : parsed.receipt.dispatch_id !== run.dispatch_id
      ? `dispatch_mismatch: receipt has ${parsed.receipt.dispatch_id}, expected ${run.dispatch_id}`
      : null;
  if (problem !== null || !parsed.ok) {
    const reason = problem ?? 'invalid_receipt';
    finishRun(tx, run, {
      ...resultFields(run, result),
      state: 'succeeded',
      outcome: 'rejected',
      reject_reason: reason,
    });
    notifyNoReceipt(ctx, tx, run, task, reason);
    if (run.kind === 'review') {
      // a reviewer without a usable receipt consumes retry budget; the work itself is unchanged
      retryLater(ctx, tx, task, 'review', { countAttempt: true, reason });
    } else {
      // the fix-round budget bounds this path; runner retries start over
      const cleared = task.attempts === 0 ? task : saveTask(tx, task, { attempts: 0 });
      requestFix(ctx, tx, cleared, `上一輪沒有交出有效回執：${reason}`, 'invalid_receipt');
    }
    return;
  }

  const cleared = task.attempts === 0 ? task : saveTask(tx, task, { attempts: 0 });
  if (run.kind === 'review') {
    applyReviewReceipt(ctx, tx, run, cleared, parsed.receipt as ReviewReceipt, result);
  } else {
    applyImplReceipt(ctx, tx, run, cleared, parsed.receipt as ImplReceipt, result);
  }
}

function applyImplReceipt(
  ctx: EngineContext,
  tx: Tx,
  run: Run,
  task: Task,
  receipt: ImplReceipt,
  result: RunResult,
): void {
  const base = { ...resultFields(run, result), state: 'succeeded' as const, receipt };
  if (receipt.needs_leader.trim() !== '') {
    openAttention(ctx, tx, {
      task_id: task.id,
      kind: 'question',
      question: receipt.needs_leader.trim(),
      options: [],
    });
  }
  if (receipt.status !== 'done') {
    finishRun(tx, run, { ...base, outcome: 'ok' });
    blockTask(ctx, tx, task, `worker 回報 ${receipt.status}：${receipt.summary}`);
    return;
  }
  // outcome is decided by verification (steps 3–5)
  finishRun(tx, run, { ...base, outcome: null });
  saveTask(tx, task, { status: 'verifying' }, `receipt accepted (run ${run.id})`);
  enqueueEffect(tx, 'run.verify', run.id, { run_id: run.id });
}

/** Must-fix list for the fix ticket. */
export function formatFindings(receipt: ReviewReceipt): string {
  const mustFix = receipt.findings.filter((f) => f.severity === 'must_fix');
  const items =
    mustFix.length > 0 ? mustFix : receipt.findings.filter((f) => f.severity !== 'note');
  const lines = items.map(
    (f) => `- [${f.severity}] \`${f.file}${f.line > 0 ? `:${f.line}` : ''}\` ${f.issue}`,
  );
  return [`審查要求修正（${receipt.summary}）：`, ...lines].join('\n');
}

function applyReviewReceipt(
  ctx: EngineContext,
  tx: Tx,
  run: Run,
  task: Task,
  receipt: ReviewReceipt,
  result: RunResult,
): void {
  finishRun(tx, run, { ...resultFields(run, result), state: 'succeeded', outcome: 'ok', receipt });
  const mustFix = receipt.findings.filter((f) => f.severity === 'must_fix').length;
  tx.emit(
    'review.completed',
    { verdict: receipt.verdict, must_fix: mustFix, findings: receipt.findings.length },
    { task_id: task.id, run_id: run.id },
  );
  if (receipt.verdict === 'pass') {
    completeTask(ctx, tx, task, `review passed (run ${run.id})`);
  } else if (receipt.verdict === 'needs_changes') {
    requestFix(ctx, tx, task, formatFindings(receipt), 'review_needs_changes');
  } else {
    blockTask(ctx, tx, task, `審查回報 blocked：${receipt.summary}`);
  }
}

function notifyNoReceipt(
  ctx: EngineContext,
  tx: Tx,
  run: Run,
  task: Task | undefined,
  detail: string,
): void {
  notify(ctx, tx, {
    kind: 'no_receipt',
    signature: `no_receipt:${run.id}`,
    body: `worker 無有效回執：${task?.title ?? run.task_id}（run ${run.id}）— ${detail}`,
    task_id: run.task_id,
  });
}
