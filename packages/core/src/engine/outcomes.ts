import type { RunKind, Task, TaskStatus } from '@agent-team/schema';
import { addMs, backoffMs } from '../util/time.js';
import type { EngineContext, Tx } from './context.js';
import { notify } from './notify.js';
import { keepWorkspace, saveTask } from './records.js';

// Task-level consequences of run outcomes. All run inside the caller's transaction.

/** Stage a task returns to for another run of `kind`. */
export function stageFor(kind: RunKind): TaskStatus {
  return kind === 'review' ? 'review' : 'queued';
}

export function blockTask(
  ctx: EngineContext,
  tx: Tx,
  task: Task,
  reason: string,
  patch: Partial<Task> = {},
): Task {
  const next = saveTask(
    tx,
    task,
    { ...patch, status: 'blocked', blocked_reason: reason, current_run_id: null, retry_at: null },
    reason,
  );
  notify(ctx, tx, {
    kind: 'task_blocked',
    signature: `task_blocked:${task.id}:${next.version}`,
    body: `任務阻塞：${task.title}（${task.id}）— ${reason}`,
    task_id: task.id,
  });
  return next;
}

export function completeTask(ctx: EngineContext, tx: Tx, task: Task, reason: string): Task {
  const next = saveTask(
    tx,
    task,
    { status: 'done', current_run_id: null, fix_notes: null, recovery_note: null, retry_at: null },
    reason,
  );
  keepWorkspace(tx, task.id);
  notify(ctx, tx, {
    kind: 'task_done',
    signature: `task_done:${task.id}`,
    body: `任務完成：${task.title}（${task.id}）`,
    task_id: task.id,
  });
  return next;
}

/**
 * Put the task back to its stage for another attempt. `countAttempt` = a failure that consumes
 * retry budget (exponential backoff; `failed` when exhausted); rate limits do not count.
 */
export function retryLater(
  ctx: EngineContext,
  tx: Tx,
  task: Task,
  kind: RunKind,
  opts: { countAttempt: boolean; reason: string },
): Task {
  const stage = stageFor(kind);
  const base = { current_run_id: null, status: stage } as const;
  if (!opts.countAttempt) {
    return saveTask(tx, task, { ...base, retry_at: null }, opts.reason);
  }
  const { engine } = ctx.config;
  const attempts = task.attempts + 1;
  if (attempts >= engine.max_attempts) {
    const next = saveTask(
      tx,
      task,
      {
        status: 'failed',
        attempts,
        current_run_id: null,
        retry_at: null,
        blocked_reason: opts.reason,
      },
      opts.reason,
    );
    notify(ctx, tx, {
      kind: 'task_failed',
      signature: `task_failed:${task.id}:${next.version}`,
      body: `任務失敗：${task.title}（${task.id}）— ${opts.reason}`,
      task_id: task.id,
    });
    return next;
  }
  const retryAt = addMs(
    tx.nowDate,
    backoffMs(attempts, engine.retry_initial_ms, engine.retry_max_ms),
  );
  return saveTask(tx, task, { ...base, attempts, retry_at: retryAt }, opts.reason);
}

/**
 * Rejection or `needs_changes` → fix run (spec §6). Once `fix_rounds` has reached
 * `rules.max_fix_rounds_before_escalate`, the next failure switches `impl_role` to the role's
 * `escalate_to` (with a fresh fix budget); with nowhere to escalate the task is blocked.
 */
export function requestFix(
  ctx: EngineContext,
  tx: Tx,
  task: Task,
  notes: string,
  cause: string,
): Task {
  const { models } = ctx.config;
  const max = models.rules.max_fix_rounds_before_escalate;
  let role = task.impl_role;
  let rounds = task.fix_rounds;
  if (rounds >= max) {
    const next = models.roles[role]?.escalate_to ?? null;
    if (next === null) {
      return blockTask(ctx, tx, task, `已達修正上限（${rounds} 輪）且無處可升級：${cause}`, {
        fix_notes: notes,
      });
    }
    tx.emit(
      'task.escalated',
      { from_role: role, to_role: next, fix_rounds: rounds },
      { task_id: task.id },
    );
    role = next;
    rounds = 0;
  }
  return saveTask(
    tx,
    task,
    {
      status: 'queued',
      impl_role: role,
      fix_rounds: rounds + 1,
      fix_notes: notes,
      current_run_id: null,
      retry_at: null,
    },
    cause,
  );
}
