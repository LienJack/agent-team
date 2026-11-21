import {
  canTransition,
  canTransitionRun,
  isTerminalTaskStatus,
  type Run,
  type Task,
  type TaskStatus,
  type Workspace,
} from '@agent-team/schema';
import { InvalidTransitionError, NotFoundError, VersionConflictError } from '../errors.js';
import type { Tx } from './context.js';

const IGNORED_TASK_FIELDS = new Set(['updated_at', 'version', 'status']);

/**
 * Persist a task change with the optimistic lock. A status change must be legal per
 * `TASK_TRANSITIONS`; emits `task.status_changed` and/or `task.updated`.
 */
export function saveTask(
  tx: Tx,
  task: Task,
  patch: Partial<Omit<Task, 'id' | 'version' | 'created_at'>>,
  reason: string | null = null,
): Task {
  const to = patch.status ?? task.status;
  if (to !== task.status && !canTransition(task.status, to)) {
    throw new InvalidTransitionError(task.id, task.status, to);
  }
  const next: Task = { ...task, ...patch, updated_at: tx.now };
  const stored = tx.r.tasks.update(next, task.version);
  if (!stored) throw new VersionConflictError('task', task.id, task.version);

  const changed = (Object.keys(patch) as (keyof Task)[]).filter(
    (k) => !IGNORED_TASK_FIELDS.has(k) && JSON.stringify(task[k]) !== JSON.stringify(stored[k]),
  );
  if (to !== task.status) {
    tx.emit('task.status_changed', { from: task.status, to, reason }, { task_id: task.id });
    if (leavesAttentionContext(task.status, to)) supersedeOpenAttention(tx, task.id);
  }
  if (changed.length > 0) tx.emit('task.updated', { fields: changed }, { task_id: task.id });
  return stored;
}

/** Leaving blocked/failed or reaching a terminal state makes the task's open questions moot. */
function leavesAttentionContext(from: TaskStatus, to: TaskStatus): boolean {
  return from === 'blocked' || from === 'failed' || isTerminalTaskStatus(to);
}

export function supersedeOpenAttention(tx: Tx, taskId: string): void {
  for (const item of tx.r.attention.list({ task_id: taskId, statuses: ['open'] })) {
    tx.r.attention.update({ ...item, status: 'superseded' });
    tx.emit('attention.superseded', { attention_id: item.id }, { task_id: taskId });
  }
}

export function requireTask(tx: Tx, id: string): Task {
  const task = tx.r.tasks.get(id);
  if (!task) throw new NotFoundError('task', id);
  return task;
}

/** Persist a run change; a state change must be legal per `RUN_TRANSITIONS`. */
export function saveRun(tx: Tx, run: Run, patch: Partial<Omit<Run, 'id'>>): Run {
  const next: Run = { ...run, ...patch };
  if (next.state !== run.state) {
    if (!canTransitionRun(run.state, next.state)) {
      throw new Error(`run ${run.id} cannot go from ${run.state} to ${next.state}`);
    }
    tx.emit(
      'run.state_changed',
      { from: run.state, to: next.state },
      { task_id: run.task_id, run_id: run.id },
    );
  }
  if (!tx.r.runs.update(next)) throw new NotFoundError('run', run.id);
  return next;
}

/** Mark a live run finished and emit `run.finished`. */
export function finishRun(tx: Tx, run: Run, patch: Partial<Omit<Run, 'id'>>): Run {
  const next = saveRun(tx, run, { ended_at: tx.now, ...patch });
  tx.emit(
    'run.finished',
    {
      state: next.state,
      outcome: next.outcome,
      reject_reason: next.reject_reason,
      error: next.error,
      usage: next.usage,
      cost_usd: next.cost_usd,
    },
    { task_id: run.task_id, run_id: run.id },
  );
  return next;
}

export function saveWorkspace(tx: Tx, ws: Workspace, patch: Partial<Omit<Workspace, 'id'>>) {
  const next = { ...ws, ...patch };
  if (!tx.r.workspaces.update(next)) throw new NotFoundError('workspace', ws.id);
  const fields = (Object.keys(patch) as (keyof Workspace)[]).filter((k) => ws[k] !== next[k]);
  if (fields.length > 0) {
    tx.emit('workspace.updated', { workspace_id: ws.id, fields }, { task_id: ws.task_id });
  }
  return next;
}

/** Workspace of a finished task is kept until the cleanup sweep removes it. */
export function keepWorkspace(tx: Tx, taskId: string): void {
  const ws = tx.r.workspaces.findCurrentByTask(taskId);
  if (ws && ws.state === 'active') saveWorkspace(tx, ws, { state: 'kept' });
}

/** The most recent run of a task (by started_at). */
export function lastRun(tx: Tx, taskId: string): Run | undefined {
  const runs = tx.r.runs.list({ task_id: taskId });
  return runs[runs.length - 1];
}
