import type { BoardTask, Run, Task } from '@agent-team/client';
import { BOARD_COLUMNS, boardColumnOf, type BoardColumnId } from '@agent-team/schema';
import { usageTokens } from './format.js';

export type Columns<T extends Task = Task> = Record<BoardColumnId, T[]>;

const byUpdatedDesc = (a: Task, b: Task) => b.updated_at.localeCompare(a.updated_at);

/** Scheduler order (spec §8): priority, then creation time. */
const bySchedule = (a: Task, b: Task) =>
  b.priority - a.priority || a.created_at.localeCompare(b.created_at);

/**
 * Tasks per board column (spec §5). Cancelled tasks are not on the board. 待派 lists queued
 * tasks in dispatch order, then drafts (newest first); other columns show the latest change first.
 */
export function groupTasks<T extends Task>(tasks: readonly T[], projectId?: string): Columns<T> {
  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, [] as T[]])) as Columns<T>;
  for (const task of tasks) {
    if (projectId !== undefined && task.project_id !== projectId) continue;
    const column = boardColumnOf(task.status);
    if (column) columns[column].push(task);
  }
  const queued = columns.pending.filter((t) => t.status === 'queued').sort(bySchedule);
  const drafts = columns.pending.filter((t) => t.status === 'draft').sort(byUpdatedDesc);
  columns.pending = [...queued, ...drafts];
  for (const id of ['in_progress', 'review', 'blocked', 'done'] as const) {
    columns[id].sort(byUpdatedDesc);
  }
  return columns;
}

export interface CardSummary {
  /** Model alias of the latest (or live) run; undefined before the first run. */
  executor: string | undefined;
  /** Kind, role and runner of that run, for the tooltip. */
  executorDetail: string | undefined;
  /** Start of the live run (the card ticks while it runs). */
  liveSince: string | undefined;
  /** Sum of all run durations (a live run counts until `now`). */
  elapsedMs: number | undefined;
  costUsd: number | null;
  /** `costUsd` includes an estimate (usage × models.json price). */
  costEstimated: boolean;
  tokens: number;
  commit: string | null;
}

function latest(runs: readonly Run[]): Run | undefined {
  let best: Run | undefined;
  for (const run of runs) if (!best || run.started_at > best.started_at) best = run;
  return best;
}

function isLive(run: Pick<Run, 'state'>): boolean {
  return run.state === 'starting' || run.state === 'running';
}

/**
 * What a card shows, straight from the board snapshot (GET /api/state carries each task's latest
 * run, head sha and run totals, so cards make no requests of their own). A live run's own time is
 * counted until `now`.
 */
export function summarizeTask(
  task: Pick<BoardTask, 'latest_run' | 'head_sha' | 'run_totals'>,
  now: number,
): CardSummary {
  const run = task.latest_run;
  const live = run !== null && isLive(run);
  const elapsed =
    task.run_totals.finished_ms + (live ? Math.max(0, now - Date.parse(run.started_at)) : 0);
  return {
    executor: run?.model_alias,
    executorDetail: run ? `${run.kind} · ${run.role} · ${run.runner}` : undefined,
    liveSince: live ? run.started_at : undefined,
    elapsedMs: task.run_totals.runs > 0 ? elapsed : undefined,
    costUsd: task.run_totals.cost_usd,
    costEstimated: task.run_totals.cost_estimated,
    tokens: usageTokens(task.run_totals.usage),
    commit: task.head_sha,
  };
}

/** The most recent run that carries a receipt (the drawer's "latest receipt"). */
export function latestReceiptRun(runs: readonly Run[]): Run | undefined {
  return latest(runs.filter((r) => r.receipt !== null));
}

/** The most recent review run with a receipt (its findings are the "review findings"). */
export function latestReviewRun(runs: readonly Run[]): Run | undefined {
  return latest(runs.filter((r) => r.kind === 'review' && r.receipt !== null));
}

export function sortRunsNewestFirst(runs: readonly Run[]): Run[] {
  return [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export { isLive as isLiveRun };
