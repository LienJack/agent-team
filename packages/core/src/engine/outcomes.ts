import type { RunKind, Task, TaskStatus } from '@agent-team/schema';
import { addMs, backoffMs } from '../util/time.js';
import { FIX_LIMIT_BLOCK } from './answers.js';
import { openAttention } from './attention.js';
import type { EngineContext, Tx } from './context.js';
import { notify } from './notify.js';
import { rememberDoneTask } from './project-memory.js';
import { saveTask } from './records.js';

// Task-level consequences of run outcomes. All run inside the caller's transaction.

/** Stage a task returns to for another run of `kind` (research: `queued`). */
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
  // the project memory keeps what was finished (spec §18): review passed, approved, research
  rememberDoneTask(ctx, tx, next);
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
 * `escalate_to` (with a fresh fix budget); with nowhere to escalate the task is blocked and an
 * attention item asks the person how to go on (docs/adr/0025): the answer reaches the next worker
 * and resumes the task with a fresh budget (answers.ts).
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
      const blocked = blockTask(
        ctx,
        tx,
        task,
        `${FIX_LIMIT_BLOCK}（${rounds} 輪）且無處可升級：${cause}`,
        {
          fix_notes: notes,
        },
      );
      openAttention(ctx, tx, {
        task_id: task.id,
        kind: 'decision',
        topic: 'fix_limit',
        question: fixLimitQuestion(task, rounds, max, cause, notes),
        options: [],
      });
      return blocked;
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

const QUESTION_NOTES_MAX = 1500;

/** The fix-limit question: what is stuck, what an answer does, and the last must-fix list. */
export function fixLimitQuestion(
  task: Task,
  rounds: number,
  budget: number,
  cause: string,
  notes: string,
): string {
  const list =
    notes.length > QUESTION_NOTES_MAX ? `${notes.slice(0, QUESTION_NOTES_MAX - 1)}…` : notes;
  return [
    `「${task.title}」（${task.id}）修正 ${rounds} 輪後仍未通過（${cause}），已沒有可升級的角色。`,
    `請回覆給下一輪 worker 的指示（例如哪些項目可以不管、先修什麼、或接受目前的做法）；回覆後任務會帶著你的指示重排，並重新給 ${budget} 輪修正額度。要放棄就在看板或 CLI 取消任務。`,
    '最後一輪要修的項目：',
    list,
  ].join('\n');
}
