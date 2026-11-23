import type { Attention, Task } from '@agent-team/schema';
import type { EngineContext, Tx } from './context.js';
import { saveTask } from './records.js';

// What a human's answer to a task's attention item does (found in the 2026-11-21 validation with
// real workers): a worker that reports `blocked` with `needs_leader` asks a question; the answer
// must reach the next worker, and answering the task's last open question resumes the task.

/** `blocked_reason` prefix of a task blocked by its worker's own report (run-result.ts). */
export const WORKER_REPORT_BLOCK = 'worker 回報 ';

/** `blocked_reason` prefix of a task whose fix rounds ran out with no role to escalate to. */
export const FIX_LIMIT_BLOCK = '已達修正上限';

/** Blocks that a person's answer (or retry) resumes; a fix-limit block also gets a fresh budget. */
export const isFixLimitBlock = (task: Task): boolean =>
  (task.blocked_reason ?? '').startsWith(FIX_LIMIT_BLOCK);

/** Answered items handed to the next prompt (newest last). */
export const PROMPT_ANSWERS_MAX = 5;

export interface PromptAnswer {
  question: string;
  answer: string;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The task's answered attention items, oldest first, at most `PROMPT_ANSWERS_MAX`. */
export function answersFor(tx: Tx, taskId: string): PromptAnswer[] {
  return tx.r.attention
    .list({ task_id: taskId, statuses: ['answered'] })
    .filter((a): a is Attention & { answer: string } => a.answer !== null && a.answer !== '')
    .sort((a, b) => (a.answered_at ?? '').localeCompare(b.answered_at ?? ''))
    .slice(-PROMPT_ANSWERS_MAX)
    .map((a) => ({ question: clip(a.question, 600), answer: clip(a.answer, 1200) }));
}

/**
 * After a human answered `item`: when its task is blocked by its worker's report and no other
 * item of the task is still open, or blocked by the fix limit and `item` is its `fix_limit`
 * question (docs/adr/0025), queue the task again (like a human retry: attempts reset, human
 * priority; a fix-limit block also restarts `fix_rounds`). The fix-limit answer is the decision:
 * notes workers left as `needs_leader` on runs that succeeded do not hold it up, and leaving
 * `blocked` supersedes them. The next prompt carries the answers. Returns the requeued task.
 */
export function resumeAfterAnswer(ctx: EngineContext, tx: Tx, item: Attention): Task | undefined {
  if (item.task_id === null) return undefined;
  const task = tx.r.tasks.get(item.task_id);
  if (!task || task.status !== 'blocked') return undefined;
  const fixLimit = isFixLimitBlock(task);
  if (!fixLimit && !(task.blocked_reason ?? '').startsWith(WORKER_REPORT_BLOCK)) return undefined;
  const decides = fixLimit && item.topic === 'fix_limit';
  if (!decides && tx.r.attention.list({ task_id: task.id, statuses: ['open'] }).length > 0) {
    return undefined;
  }
  const next = saveTask(
    tx,
    task,
    {
      status: 'queued',
      attempts: 0,
      leader_retries: 0,
      retry_at: null,
      blocked_reason: null,
      current_run_id: null,
      ...(fixLimit ? { fix_rounds: 0 } : {}),
    },
    `answered (${item.id}): queued again with the answer`,
  );
  ctx.humanPriority.add(task.id);
  return next;
}
