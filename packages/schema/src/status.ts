import { z } from 'zod';

// ---------------------------------------------------------------- task status

export const TASK_STATUSES = [
  'draft',
  'queued',
  'running',
  'verifying',
  'review',
  'done',
  'blocked',
  'failed',
  'cancelled',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Legal task status transitions (spec §5). Only the engine changes status, always through this
 * table and an optimistic `version` check.
 *
 * - `queued`: waiting for an impl or fix run. `review`: committed, waiting for/under model review.
 * - `blocked`/`failed` → `queued` or `review` on retry (back to the stage the task was in).
 * - `done` and `cancelled` are terminal.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'blocked', 'failed', 'cancelled'],
  running: ['verifying', 'queued', 'blocked', 'failed', 'cancelled'],
  verifying: ['review', 'queued', 'blocked', 'cancelled'],
  review: ['done', 'queued', 'blocked', 'failed', 'cancelled'],
  blocked: ['queued', 'review', 'cancelled'],
  failed: ['queued', 'review', 'cancelled'],
  done: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** Board columns (spec §5). `cancelled` tasks are not shown on the board. */
export const BOARD_COLUMNS = [
  { id: 'pending', label: '待派', statuses: ['draft', 'queued'] },
  { id: 'in_progress', label: '進行中', statuses: ['running', 'verifying'] },
  { id: 'review', label: '待驗收', statuses: ['review'] },
  { id: 'blocked', label: '阻塞', statuses: ['blocked', 'failed'] },
  { id: 'done', label: '完成', statuses: ['done'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; statuses: readonly TaskStatus[] }>;
export type BoardColumnId = (typeof BOARD_COLUMNS)[number]['id'];

export function boardColumnOf(status: TaskStatus): BoardColumnId | undefined {
  return BOARD_COLUMNS.find((c) => (c.statuses as readonly TaskStatus[]).includes(status))?.id;
}

// ----------------------------------------------------------------- run state

export const RUN_STATES = [
  'starting',
  'running',
  'succeeded',
  'failed',
  'start_unknown',
  'stopped',
  'abandoned',
] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

/** States in which a run may still produce a result. */
export const LIVE_RUN_STATES: readonly RunState[] = ['starting', 'running'];

/** Legal run state transitions. A runner may finish without ever reporting "started". */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  starting: ['running', 'succeeded', 'failed', 'start_unknown', 'stopped', 'abandoned'],
  running: ['succeeded', 'failed', 'stopped', 'abandoned'],
  succeeded: [],
  failed: [],
  start_unknown: [],
  stopped: [],
  abandoned: [],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isLiveRunState(state: RunState): boolean {
  return LIVE_RUN_STATES.includes(state);
}

export const RunKindSchema = z.enum(['impl', 'fix', 'review']);
export type RunKind = z.infer<typeof RunKindSchema>;

export const RunOutcomeSchema = z.enum([
  'ok',
  'rejected',
  'error',
  'rate_limited',
  'timeout',
  'cancelled',
]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Result of trying to dispatch a task (spec §8). `deferred` never creates a run. */
export const DispatchOutcomeSchema = z.enum(['accepted', 'rejected', 'unknown', 'deferred']);
export type DispatchOutcome = z.infer<typeof DispatchOutcomeSchema>;
