import { NotFoundError } from '@agent-team/core';
import {
  deliveryOf,
  deliveryReport,
  isLiveRunState,
  type JsonValue,
  type TaskCommandResponse,
} from '@agent-team/schema';
import type { AppContext } from './types.js';
import { within } from './within.js';

// The `delivery` and `report` of task command responses (docs/adr/0022 §1): derived from the
// stored task, its current run and the scheduler's waiting reason at response time — never from
// what the command intended — so the leader can relay the report and cannot call a queued task
// "running".

/**
 * Longest a task command waits for the scheduling pass that may dispatch it. After it the reply
 * says what is stored at that moment (typically `queued`, reason not known yet).
 */
export const DELIVERY_SETTLE_MS = 3000;

/** `{ task, delivery, report }` of a task as it is stored now. */
export function commandReply(ctx: AppContext, taskId: string): TaskCommandResponse {
  const task = ctx.store.tasks.get(taskId);
  if (!task) throw new NotFoundError('task', taskId);
  const run = task.current_run_id === null ? undefined : ctx.store.runs.get(task.current_run_id);
  const shown = ctx.engine.waitingOf(taskId);
  const delivery = deliveryOf({
    task,
    liveRunId: run && isLiveRunState(run.state) ? run.id : null,
    waiting: shown
      ? {
          reason: shown.reason,
          detail: shown.detail,
          blocking_task_id: shown.blocking_task_id,
          retry_at: shown.retry_at,
        }
      : null,
  });
  return { task, delivery, report: deliveryReport(task, delivery) };
}

/** After a command: one scheduling pass (bounded), then the reply. */
export async function settledReply(ctx: AppContext, taskId: string): Promise<TaskCommandResponse> {
  await within(ctx.engine.settle(), DELIVERY_SETTLE_MS);
  return commandReply(ctx, taskId);
}

function commandTaskId(body: JsonValue): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (!('delivery' in body) || !('report' in body)) return undefined;
  const task = body['task'];
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return undefined;
  const id = task['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * A replayed task command (same Idempotency-Key, e.g. the leader's replayed turn): the stored
 * reply would repeat a delivery that may be stale, so task, delivery and report are recomputed;
 * other replies (and errors) are returned as stored.
 */
export function refreshReplay(ctx: AppContext, body: JsonValue): JsonValue {
  const id = commandTaskId(body);
  if (id === undefined || !ctx.store.tasks.get(id)) return body;
  return commandReply(ctx, id) as unknown as JsonValue;
}
