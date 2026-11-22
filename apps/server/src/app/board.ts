import type { Store } from '@agent-team/core';
import {
  boardSummary,
  type BoardTask,
  type Run,
  type StateResponse,
  type Usage,
  type Workspace,
} from '@agent-team/schema';
import type { AppContext } from './types.js';

// GET /api/state (spec §11, §13): the board snapshot. Every task carries what its card shows —
// its latest run, the workspace's last service-side commit and sums over its runs — so the board
// renders from this one response instead of one detail request per card.

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
] as const;

function addUsage(total: Usage, usage: Usage | null): void {
  if (!usage) return;
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (value !== undefined) total[key] = (total[key] ?? 0) + value;
  }
}

/** Card fields of one task from its runs (store order: oldest first) and current workspace. */
export function cardFields(
  task: { current_run_id: string | null },
  runs: readonly Run[],
  workspace: Pick<Workspace, 'head_sha'> | undefined,
): Pick<BoardTask, 'latest_run' | 'head_sha' | 'run_totals'> {
  let latest: Run | undefined;
  let cost: number | null = null;
  let estimated = false;
  let finished = 0;
  const usage: Usage = {};
  for (const run of runs) {
    if (!latest || run.started_at >= latest.started_at) latest = run;
    if (run.cost_usd !== null) {
      cost = (cost ?? 0) + run.cost_usd;
      estimated ||= run.cost_estimated;
    }
    addUsage(usage, run.usage);
    if (run.ended_at !== null) {
      finished += Math.max(0, Date.parse(run.ended_at) - Date.parse(run.started_at));
    }
  }
  const shown = runs.find((r) => r.id === task.current_run_id) ?? latest;
  return {
    latest_run: shown
      ? {
          id: shown.id,
          kind: shown.kind,
          role: shown.role,
          model_alias: shown.model_alias,
          runner: shown.runner,
          state: shown.state,
          cost_usd: shown.cost_usd,
          cost_estimated: shown.cost_estimated,
          usage: shown.usage,
          started_at: shown.started_at,
          ended_at: shown.ended_at,
        }
      : null,
    head_sha: workspace?.head_sha ?? null,
    run_totals: {
      runs: runs.length,
      cost_usd: cost,
      cost_estimated: estimated,
      usage,
      finished_ms: finished,
    },
  };
}

function boardTasks(
  store: Store,
  waitingOf: (taskId: string) => BoardTask['waiting'],
): BoardTask[] {
  const runsByTask = new Map<string, Run[]>();
  for (const run of store.runs.list()) {
    const list = runsByTask.get(run.task_id);
    if (list) list.push(run);
    else runsByTask.set(run.task_id, [run]);
  }
  return store.tasks.list().map((task) => ({
    ...task,
    ...cardFields(task, runsByTask.get(task.id) ?? [], store.workspaces.findCurrentByTask(task.id)),
    // why a waiting task is not dispatched (the engine's last scheduling pass; task.waiting)
    waiting: task.status === 'queued' || task.status === 'review' ? waitingOf(task.id) : null,
  }));
}

/** GET /api/state: one synchronous read, so `last_seq` matches the rows exactly. */
export function boardSnapshot(ctx: AppContext): StateResponse {
  const { store } = ctx;
  const tasks = boardTasks(store, (id) => ctx.engine.waitingOf(id));
  return {
    last_seq: store.events.lastSeq(),
    generated_at: ctx.clock.now().toISOString(),
    projects: store.projects.list(),
    tasks,
    active_runs: store.runs.list({ states: ['starting', 'running'] }),
    open_attention: store.attention.list({ statuses: ['open'] }),
    runners: ctx.engine.runnerStatuses(),
    leader: ctx.leader.status(),
    // counts per column that sum (team status relays the line; docs/adr/0022)
    summary: boardSummary(tasks),
    memory_enabled:
      ctx.engine.ctx.config.memory.enabled && ctx.engine.ctx.deps.memory !== undefined,
  };
}
