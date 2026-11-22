import {
  isLiveRunState,
  parseReceipt,
  RECEIPT_SUMMARY_MAX,
  redactSecrets,
  type Receipt,
  type ImplReceipt,
  type ResearchReceipt,
  type ReviewReceipt,
  type Run,
  type RunOutcome,
  type RunResult,
  type RunState,
  type Task,
} from '@agent-team/schema';
import type { EngineContext, Tx } from './context.js';
import { estimateCostUsd } from './cost.js';
import { WORKER_REPORT_BLOCK } from './answers.js';
import { openAttention } from './attention.js';
import { enqueueEffect } from './effect-queue.js';
import { notify } from './notify.js';
import { blockTask, completeTask, requestFix, retryLater } from './outcomes.js';
import { finishRun, saveTask } from './records.js';
import { applyResearchReceipt } from './research.js';
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

/**
 * The receipt as it is stored, shown on the board, handed to the leader, Grok and the reviewer:
 * every string masked with the log redactor (M8), the summary clamped again afterwards.
 */
export function redactReceipt<T extends Receipt>(receipt: T): T {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactSecrets(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const out = walk(receipt) as T;
  out.summary = out.summary.slice(0, RECEIPT_SUMMARY_MAX);
  return out;
}

/** Usage, cost (reported, else estimated from models.json prices) and session of a result. */
function resultFields(ctx: EngineContext, run: Run, result: RunResult) {
  const usage = result.usage ?? run.usage;
  const reported = result.costUsd ?? (run.cost_estimated ? null : run.cost_usd);
  const estimate =
    reported === null ? estimateCostUsd(ctx.config.models, run.model_alias, usage) : undefined;
  return {
    usage,
    cost_usd: reported ?? estimate ?? null,
    cost_estimated: reported === null && estimate !== undefined,
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
      ...resultFields(ctx, run, result),
      state,
      outcome,
      error: `${kind}: ${message}`,
    });
    if (kind === 'rate_limit') {
      startCooldown(ctx, tx, run, result.quota?.resetsAt, `rate limit (run ${run.id})`);
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
      ...resultFields(ctx, run, result),
      state: 'succeeded',
      outcome: 'rejected',
      reject_reason: 'stale_dispatch: run is no longer the task’s current run',
    });
    return;
  }

  const kind = run.kind === 'review' || run.kind === 'research' ? run.kind : 'impl';
  const parsed = parseReceipt(kind, result.final);
  const problem = !parsed.ok
    ? `invalid_receipt: ${parsed.error}`
    : parsed.receipt.dispatch_id !== run.dispatch_id
      ? `dispatch_mismatch: receipt has ${parsed.receipt.dispatch_id}, expected ${run.dispatch_id}`
      : null;
  if (problem !== null || !parsed.ok) {
    const reason = problem ?? 'invalid_receipt';
    finishRun(tx, run, {
      ...resultFields(ctx, run, result),
      state: 'succeeded',
      outcome: 'rejected',
      reject_reason: reason,
    });
    notifyNoReceipt(ctx, tx, run, task, reason);
    if (run.kind === 'review' || run.kind === 'research') {
      // a reviewer (or researcher) without a usable receipt consumes retry budget; there is no
      // work to fix (a fix ticket would turn the next run into a fix run)
      retryLater(ctx, tx, task, run.kind, { countAttempt: true, reason });
    } else {
      // the fix-round budget bounds this path; runner retries start over
      const cleared = task.attempts === 0 ? task : saveTask(tx, task, { attempts: 0 });
      requestFix(ctx, tx, cleared, `上一輪沒有交出有效回執：${reason}`, 'invalid_receipt');
    }
    return;
  }

  const cleared = task.attempts === 0 ? task : saveTask(tx, task, { attempts: 0 });
  if (run.kind === 'research') {
    // redacted, clipped and validated again inside (spec §17)
    const fields = resultFields(ctx, run, result);
    applyResearchReceipt(ctx, tx, run, cleared, parsed.receipt as ResearchReceipt, fields);
    return;
  }
  const receipt = redactReceipt(parsed.receipt);
  if (run.kind === 'review') {
    applyReviewReceipt(ctx, tx, run, cleared, receipt as ReviewReceipt, result);
  } else {
    applyImplReceipt(ctx, tx, run, cleared, receipt as ImplReceipt, result);
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
  const base = { ...resultFields(ctx, run, result), state: 'succeeded' as const, receipt };
  if (receipt.needs_leader.trim() !== '') {
    openAttention(ctx, tx, {
      task_id: task.id,
      kind: 'question',
      topic: 'worker_question',
      question: receipt.needs_leader.trim(),
      options: [],
    });
  }
  if (receipt.status !== 'done') {
    finishRun(tx, run, { ...base, outcome: 'ok' });
    blockTask(ctx, tx, task, `${WORKER_REPORT_BLOCK}${receipt.status}：${receipt.summary}`);
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
  finishRun(tx, run, {
    ...resultFields(ctx, run, result),
    state: 'succeeded',
    outcome: 'ok',
    receipt,
  });
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
