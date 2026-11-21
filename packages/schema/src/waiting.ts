import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { TaskIdSchema } from './ids.js';

/**
 * Why a waiting task is not dispatched (`task.waiting`, and on the board card):
 * - `path_overlap`: its owned_paths may overlap a task in progress (`blocking_task_id`);
 * - `no_slot`: the role's slots or the global cap are taken;
 * - `runner_cooldown`: no runner of the role is usable now (rate limit, circuit, quota) — until
 *   `retry_at` when known;
 * - `backoff`: retrying after a failure at `retry_at`;
 * - `worker_alive`: its previous worker process may still be running;
 * - `base_drift`: the base branch moved under its owned_paths; a person decides.
 */
export const TaskWaitReasonSchema = z.enum([
  'path_overlap',
  'no_slot',
  'runner_cooldown',
  'backoff',
  'worker_alive',
  'base_drift',
]);
export type TaskWaitReason = z.infer<typeof TaskWaitReasonSchema>;

export const TaskWaitingSchema = z.object({
  reason: TaskWaitReasonSchema,
  /** Short English detail (role, cap, runner reason); null when the reason says it all. */
  detail: z.string().nullable(),
  blocking_task_id: TaskIdSchema.nullable(),
  retry_at: IsoDateTimeSchema.nullable(),
});
export type TaskWaiting = z.infer<typeof TaskWaitingSchema>;
