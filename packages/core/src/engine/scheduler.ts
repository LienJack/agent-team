import type { EngineSettings, ModelsConfig, Run, RunKind, Task } from '@agent-team/schema';
import { ownedPathsOverlap } from '../util/paths.js';
import { isAfter } from '../util/time.js';
import type { ResolvedModel, ResolveRoleResult } from './resolve-role.js';

/** Statuses whose owned_paths block other tasks (work exists in their worktree). */
export const PATH_HOLDING_STATUSES = ['running', 'verifying', 'review'] as const;

/** Which run a task needs next, if it is waiting for one. */
export function nextRunKind(task: Task): RunKind | undefined {
  if (task.current_run_id !== null) return undefined;
  if (task.status === 'review') return 'review';
  if (task.status === 'queued') return task.fix_notes === null ? 'impl' : 'fix';
  return undefined;
}

/** Role that performs a run of `kind` for `task`. */
export function roleFor(task: Task, kind: RunKind): string {
  return kind === 'review' ? `review_${task.tier}` : task.impl_role;
}

export interface PlanInput {
  /** Every task in a waiting or path-holding status. */
  tasks: readonly Task[];
  /** Runs in starting/running state. */
  liveRuns: readonly Run[];
  /** Tasks being prepared right now: task id → role. */
  dispatching: ReadonlyMap<string, string>;
  /** Paths of tasks being prepared right now. */
  dispatchingPaths: ReadonlyArray<readonly string[]>;
  /** Tasks whose previous worker process may still be running here: never dispatched (H2). */
  workerTasks?: ReadonlySet<string>;
  /** Whether a project's filesystem ignores case (overlap check); unknown → true. */
  ignoreCaseOf?: (projectId: string) => boolean;
  humanPriority: ReadonlySet<string>;
  models: ModelsConfig;
  engine: EngineSettings;
  now: Date;
  /** Resolve a role, excluding aliases (reviewer ≠ implementer). */
  resolve(role: string, excludeAliases: readonly string[]): ResolveRoleResult;
  /** Alias of the most recent impl/fix run of a task (for review exclusion). */
  implAliasOf(taskId: string): string | undefined;
}

export interface PlannedDispatch {
  task: Task;
  kind: RunKind;
  role: string;
  human: boolean;
  resolved: ResolvedModel;
}

export type DeferReason =
  | 'global_cap'
  | 'role_slots'
  | 'path_overlap'
  | 'no_model'
  | 'unknown_role'
  | 'backoff'
  | 'worker_alive';

export interface Deferred {
  task_id: string;
  reason: DeferReason;
  retry_at: string | null;
  /** The path-holding task it may overlap (`path_overlap`; '' = one being dispatched). */
  blocking_task_id?: string;
  /** The full role (`role_slots`) or why no model resolved (`no_model`). */
  detail?: string;
}

export interface PlanResult {
  dispatch: PlannedDispatch[];
  deferred: Deferred[];
  /** Tasks whose role cannot be resolved at all (unknown/disabled role): to be blocked. */
  invalid: Array<{ task: Task; reason: string }>;
}

function byPriority(human: ReadonlySet<string>) {
  return (a: Task, b: Task): number => {
    const ha = human.has(a.id) ? 1 : 0;
    const hb = human.has(b.id) ? 1 : 0;
    if (ha !== hb) return hb - ha;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * Choose what to dispatch now (spec §8). Pure. Waiting tasks are taken by human priority, then
 * `priority` (higher first), then creation time. Limits: `roles.<role>.slots` per role, the global
 * cap `max_concurrent_runs` minus `reserved_human_slots` for non-human work, and no impl/fix run
 * whose owned_paths may overlap a path-holding task (uncertain = overlap). Review runs are
 * read-only and skip the path check.
 */
export function planDispatch(input: PlanInput): PlanResult {
  const { engine, models, now } = input;
  const result: PlanResult = { dispatch: [], deferred: [], invalid: [] };
  const roleCount = new Map<string, number>();
  const bump = (role: string) => roleCount.set(role, (roleCount.get(role) ?? 0) + 1);
  for (const run of input.liveRuns) bump(run.role);
  for (const role of input.dispatching.values()) bump(role);
  let total = input.liveRuns.length + input.dispatching.size;

  const ignoreCaseOf = input.ignoreCaseOf ?? (() => true);
  const held: Array<{ id: string; project: string | null; paths: readonly string[] }> = input.tasks
    .filter((t) => (PATH_HOLDING_STATUSES as readonly string[]).includes(t.status))
    .map((t) => ({ id: t.id, project: t.project_id, paths: t.owned_paths }));
  for (const paths of input.dispatchingPaths) held.push({ id: '', project: null, paths });
  const overlaps = (h: (typeof held)[number], task: Task) =>
    ownedPathsOverlap(h.paths, task.owned_paths, {
      ignoreCase: ignoreCaseOf(task.project_id) || h.project === null || ignoreCaseOf(h.project),
    });

  const waiting = input.tasks
    .filter((t) => nextRunKind(t) !== undefined && !input.dispatching.has(t.id))
    .sort(byPriority(input.humanPriority));

  for (const task of waiting) {
    const kind = nextRunKind(task)!;
    const defer = (
      reason: DeferReason,
      retryAt: string | null = null,
      extra: Pick<Deferred, 'blocking_task_id' | 'detail'> = {},
    ) => result.deferred.push({ task_id: task.id, reason, retry_at: retryAt, ...extra });
    if (isAfter(task.retry_at, now)) {
      defer('backoff', task.retry_at);
      continue;
    }
    if (input.workerTasks?.has(task.id)) {
      defer('worker_alive');
      continue;
    }
    const role = roleFor(task, kind);
    const roleCfg = models.roles[role];
    if (!roleCfg || !roleCfg.enabled) {
      result.invalid.push({ task, reason: `${roleCfg ? 'disabled' : 'unknown'} role ${role}` });
      continue;
    }
    const human = input.humanPriority.has(task.id);
    const cap = human
      ? engine.max_concurrent_runs
      : engine.max_concurrent_runs - engine.reserved_human_slots;
    if (total >= cap) {
      defer('global_cap');
      continue;
    }
    if ((roleCount.get(role) ?? 0) >= roleCfg.slots) {
      defer('role_slots', null, { detail: `${role}: ${roleCfg.slots} slot(s) in use` });
      continue;
    }
    const blocker =
      kind === 'review' ? undefined : held.find((h) => h.id !== task.id && overlaps(h, task));
    if (blocker) {
      defer('path_overlap', null, { blocking_task_id: blocker.id });
      continue;
    }
    const exclude =
      kind === 'review' && models.rules.reviewer_must_differ_from_implementer
        ? [input.implAliasOf(task.id)].filter((a): a is string => a !== undefined)
        : [];
    const resolved = input.resolve(role, exclude);
    if (!resolved.ok) {
      if (resolved.reason === 'no_candidate') {
        defer('no_model', resolved.retryAt, { detail: `no usable model for ${role}` });
      } else result.invalid.push({ task, reason: `${resolved.reason} ${role}` });
      continue;
    }
    result.dispatch.push({ task, kind, role, human, resolved });
    total++;
    bump(role);
    if (kind !== 'review') {
      held.push({ id: task.id, project: task.project_id, paths: task.owned_paths });
    }
  }
  return result;
}
