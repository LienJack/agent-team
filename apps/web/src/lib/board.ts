import type { Run, Task, TaskDetail } from '@agent-team/client';
import { BOARD_COLUMNS, boardColumnOf, type BoardColumnId } from '@agent-team/schema';
import { usageTokens } from './format.js';

export type Columns = Record<BoardColumnId, Task[]>;

const byUpdatedDesc = (a: Task, b: Task) => b.updated_at.localeCompare(a.updated_at);

/** Scheduler order (spec §8): priority, then creation time. */
const bySchedule = (a: Task, b: Task) =>
  b.priority - a.priority || a.created_at.localeCompare(b.created_at);

/**
 * Tasks per board column (spec §5). Cancelled tasks are not on the board. 待派 lists queued
 * tasks in dispatch order, then drafts (newest first); other columns show the latest change first.
 */
export function groupTasks(tasks: readonly Task[], projectId?: string): Columns {
  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, [] as Task[]])) as Columns;
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
  tokens: number;
  commit: string | null;
}

function latest(runs: readonly Run[]): Run | undefined {
  let best: Run | undefined;
  for (const run of runs) if (!best || run.started_at > best.started_at) best = run;
  return best;
}

function isLive(run: Run): boolean {
  return run.state === 'starting' || run.state === 'running';
}

/**
 * What a card shows, from the task's detail (runs, workspace) when loaded and the snapshot's
 * active run otherwise.
 */
export function summarizeTask(
  task: Pick<Task, 'current_run_id'>,
  detail: Pick<TaskDetail, 'runs' | 'workspace'> | undefined,
  activeRun: Run | undefined,
  now: number,
): CardSummary {
  const runs = detail?.runs ?? (activeRun ? [activeRun] : []);
  const current =
    (task.current_run_id ? runs.find((r) => r.id === task.current_run_id) : undefined) ??
    activeRun ??
    latest(runs);
  let elapsed = 0;
  let cost: number | null = null;
  let tokens = 0;
  for (const run of runs) {
    const end = run.ended_at ? Date.parse(run.ended_at) : now;
    elapsed += Math.max(0, end - Date.parse(run.started_at));
    if (run.cost_usd !== null) cost = (cost ?? 0) + run.cost_usd;
    tokens += usageTokens(run.usage);
  }
  return {
    executor: current?.model_alias,
    executorDetail: current ? `${current.kind} · ${current.role} · ${current.runner}` : undefined,
    liveSince: current && isLive(current) ? current.started_at : undefined,
    elapsedMs: runs.length > 0 ? elapsed : undefined,
    costUsd: cost,
    tokens,
    commit: detail?.workspace?.head_sha ?? null,
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
