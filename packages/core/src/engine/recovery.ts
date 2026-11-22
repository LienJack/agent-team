import { isTerminalTaskStatus, type Run } from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import { addMs } from '../util/time.js';
import type { EngineContext, Tx } from './context.js';
import { openAttention } from './attention.js';
import { projectIgnoresCase } from './dispatch.js';
import { enqueueEffect } from './effect-queue.js';
import { blockTask } from './outcomes.js';
import { recoveryNoteFor } from './prompt.js';
import { finishRun, saveTask } from './records.js';
import { WORKER_UNCONFIRMED, WORKER_UNCONFIRMED_BLOCK } from './start-unknown.js';

export interface RecoveryReport {
  abandonedRuns: string[];
  requeuedTasks: string[];
  /** Tasks blocked because their worker could not be confirmed dead (docs/adr/0015). */
  blockedTasks: string[];
  /** Runs whose leftover worker process group was terminated before requeueing. */
  terminatedRuns: string[];
  orphanWorktrees: string[];
  pendingEffects: number;
  clearedIdempotency: number;
}

/**
 * What happened to the worker of a run left live by a previous process:
 * - `gone`: never spawned (no launch recorded) or provably not running any more;
 * - `terminated`: its process group (same pid and OS start time) was killed just now;
 * - `unconfirmed`: it may still be running (launched without a recorded pid, no process control,
 *   group members left without their leader, kill failed). The task gets no other worker.
 */
export type WorkerFate = 'gone' | 'terminated' | 'unconfirmed';

async function workerFate(ctx: EngineContext, run: Run): Promise<WorkerFate> {
  if (run.pid === null) return run.launched_at === null ? 'gone' : 'unconfirmed';
  const control = ctx.deps.processes;
  if (!control) return 'unconfirmed';
  try {
    const res = await control.terminateGroup({ pid: run.pid, startedAt: run.pid_started_at });
    return res === 'terminated' ? 'terminated' : res === 'not_running' ? 'gone' : 'unconfirmed';
  } catch (err) {
    ctx.logger.error('cannot terminate worker group', { run_id: run.id, error: errorMessage(err) });
    return 'unconfirmed';
  }
}

/**
 * Every live (`starting`/`running`) run → `abandoned`. Its task goes back to `queued`
 * (impl/fix) or stays in `review` (review run), with a recovery note for the next prompt and
 * attempts unchanged — unless `fates` says its worker may still be running: then the task is
 * blocked with one attention item, so no second worker enters the worktree until a human has
 * checked (only a human may retry it). Used by startup recovery (after terminating leftover
 * worker groups) and by a graceful shutdown (after the runners terminated their groups).
 */
export function abandonLiveRuns(
  ctx: EngineContext,
  tx: Tx,
  why: 'restart' | 'shutdown',
  fates: ReadonlyMap<string, WorkerFate> = new Map(),
): { abandonedRuns: string[]; requeuedTasks: string[]; blockedTasks: string[] } {
  const abandonedRuns: string[] = [];
  const requeuedTasks: string[] = [];
  const blockedTasks: string[] = [];
  const error = why === 'restart' ? 'abandoned: service restarted' : 'abandoned: service stopped';
  for (const run of tx.r.runs.list({ states: ['starting', 'running'] })) {
    // a research run has no worktree a leftover worker could still change: simply requeued
    const unconfirmed = fates.get(run.id) === 'unconfirmed' && run.kind !== 'research';
    const pid = run.pid === null ? 'pid unknown' : `pid ${run.pid}`;
    finishRun(tx, run, {
      state: 'abandoned',
      error: unconfirmed ? `${WORKER_UNCONFIRMED} (${pid}; service restarted)` : error,
    });
    abandonedRuns.push(run.id);
    const task = tx.r.tasks.get(run.task_id);
    if (!task || task.current_run_id !== run.id) continue;
    if (unconfirmed) {
      blockTask(
        ctx,
        tx,
        task,
        `${WORKER_UNCONFIRMED_BLOCK} 服務重啟後無法確認 run ${run.id} 的 worker 已結束（${pid}）`,
        {
          recovery_note: recoveryNoteFor(run.id, run.dispatch_id, run.kind),
        },
      );
      openAttention(ctx, tx, {
        task_id: task.id,
        kind: 'decision',
        question: `${task.title}（${task.id}）的 run ${run.id} 在服務重啟前已啟動 worker（${pid}），無法確認它已結束；確認沒有殘留的行程後再重試。`,
        options: ['重試', '取消'],
      });
      blockedTasks.push(task.id);
      continue;
    }
    saveTask(
      tx,
      task,
      {
        status: run.kind === 'review' ? task.status : 'queued',
        current_run_id: null,
        retry_at: null,
        // the research prompt is the question alone: nothing in a worktree to resume from
        recovery_note:
          run.kind === 'research' ? null : recoveryNoteFor(run.id, run.dispatch_id, run.kind),
      },
      why === 'restart'
        ? `recovered after restart (run ${run.id} abandoned)`
        : `service stopped (run ${run.id} abandoned)`,
    );
    requeuedTasks.push(task.id);
  }
  return { abandonedRuns, requeuedTasks, blockedTasks };
}

/**
 * Startup recovery (spec §8). Run once before the first tick:
 * 1. the worker of every run left `starting`/`running` is dealt with first (docs/adr/0015): a
 *    recorded process group is terminated only if its leader is still the same process (pid and
 *    OS start time); one that cannot be confirmed dead blocks its task instead of requeueing it;
 * 2. those runs → `abandoned`; tasks back to `queued` (impl/fix) or still `review` (review
 *    runs — the committed work is intact) with a recovery note for the next prompt;
 * 3. pending idempotency records are dropped (nothing can still be processing them);
 * 4. worktrees under the worktree root with no workspace record get a `workspace.remove` effect
 *    (forced: nothing references them; docs/adr/0009);
 * 5. unfinished effects simply run again (start effects of abandoned runs become no-ops).
 */
export async function recover(ctx: EngineContext): Promise<RecoveryReport> {
  const fates = new Map<string, WorkerFate>();
  for (const run of ctx.store.runs.list({ states: ['starting', 'running'] })) {
    fates.set(run.id, await workerFate(ctx, run));
  }
  // a run stopped (cancel, reject, approve) shortly before the crash may still have its group
  // terminating: the same identity check, for tasks that can still get another worker
  const stoppedUnconfirmed: Run[] = [];
  for (const run of ctx.store.runs.list({ states: ['stopped'] })) {
    if (run.pid === null) continue;
    const task = ctx.store.tasks.get(run.task_id);
    if (!task || isTerminalTaskStatus(task.status)) continue;
    const fate = await workerFate(ctx, run);
    fates.set(run.id, fate);
    if (fate === 'unconfirmed' && run.kind !== 'research') stoppedUnconfirmed.push(run);
  }
  const terminatedRuns = [...fates].filter(([, f]) => f === 'terminated').map(([id]) => id);
  const report = ctx.transact((tx) => {
    const { abandonedRuns, requeuedTasks, blockedTasks } = abandonLiveRuns(
      ctx,
      tx,
      'restart',
      fates,
    );
    for (const run of stoppedUnconfirmed) {
      const task = tx.r.tasks.get(run.task_id);
      if (!task || isTerminalTaskStatus(task.status)) continue;
      if (task.status === 'blocked' || task.status === 'failed') continue;
      blockTask(
        ctx,
        tx,
        task,
        `${WORKER_UNCONFIRMED_BLOCK} 服務重啟後無法確認已停止的 run ${run.id} 的 worker 已結束（pid ${run.pid}）`,
      );
      openAttention(ctx, tx, {
        task_id: task.id,
        kind: 'decision',
        question: `${task.title}（${task.id}）已停止的 run ${run.id}（pid ${run.pid}）在重啟後無法確認已結束；確認沒有殘留的行程後再重試。`,
        options: ['重試', '取消'],
      });
      if (!blockedTasks.includes(task.id)) blockedTasks.push(task.id);
      const i = requeuedTasks.indexOf(task.id);
      if (i >= 0) requeuedTasks.splice(i, 1);
    }
    // a verifying task whose verify effect is missing would hang: re-enqueue it
    for (const task of tx.r.tasks.list({ statuses: ['verifying'] })) {
      if (task.current_run_id && !tx.r.effects.get('run.verify', task.current_run_id)) {
        enqueueEffect(tx, 'run.verify', task.current_run_id, { run_id: task.current_run_id });
      }
    }
    let clearedIdempotency = 0;
    for (const rec of tx.r.idempotency.listByState('pending')) {
      if (tx.r.idempotency.delete(rec.caller, rec.request_id)) clearedIdempotency++;
    }
    return { abandonedRuns, requeuedTasks, blockedTasks, clearedIdempotency };
  });

  const orphanWorktrees: string[] = [];
  for (const project of ctx.store.projects.list()) {
    await projectIgnoresCase(ctx, project);
    let managed: Array<{ worktreePath: string }>;
    try {
      managed = await ctx.deps.git.listManagedWorktrees({
        repoPath: project.repo_path,
        root: ctx.config.worktreeRoot,
      });
    } catch (err) {
      ctx.logger.warn('cannot list worktrees', { project: project.name, error: errorMessage(err) });
      continue;
    }
    const known = new Set(
      ctx.store.workspaces
        .list({ states: ['active', 'kept'] })
        .map((w) => w.path.replace(/\/+$/, '')),
    );
    for (const wt of managed) {
      const path = wt.worktreePath.replace(/\/+$/, '');
      if (known.has(path)) continue;
      orphanWorktrees.push(path);
      ctx.transact((tx) =>
        enqueueEffect(tx, 'workspace.remove', path, {
          workspace_id: null,
          repo_path: project.repo_path,
          path,
          reason: 'orphan',
        }),
      );
    }
  }

  return ctx.transact((tx) => {
    const pendingEffects = tx.r.effects.list().length;
    tx.emit('recovery.completed', {
      abandoned_runs: report.abandonedRuns,
      requeued_tasks: report.requeuedTasks,
      blocked_tasks: report.blockedTasks,
      terminated_runs: terminatedRuns,
      orphan_worktrees: orphanWorktrees.length,
      pending_effects: pendingEffects,
      cleared_idempotency: report.clearedIdempotency,
    });
    return { ...report, terminatedRuns, orphanWorktrees, pendingEffects };
  });
}

/**
 * Cleanup sweep (spec §8): worktrees of tasks that are done/cancelled for longer than
 * `worktree_retention_hours` get a `workspace.remove` effect (branches are kept).
 */
export function sweepWorkspaces(ctx: EngineContext): number {
  const now = ctx.now();
  const cutoff = addMs(now, -ctx.config.engine.worktree_retention_hours * 3600_000);
  let queued = 0;
  for (const task of ctx.store.tasks.list({ statuses: ['done', 'cancelled'] })) {
    if (task.updated_at > cutoff) continue;
    const ws = ctx.store.workspaces.findCurrentByTask(task.id);
    // `kept` = a removal found uncommitted changes; a human decides, never swept again
    if (!ws || ws.state !== 'active' || ctx.store.effects.get('workspace.remove', ws.id)) continue;
    const project = ctx.store.projects.get(task.project_id);
    if (!project) continue;
    ctx.transact((tx) =>
      enqueueEffect(tx, 'workspace.remove', ws.id, {
        workspace_id: ws.id,
        repo_path: project.repo_path,
        path: ws.path,
        reason: 'cleanup',
      }),
    );
    queued++;
  }
  return queued;
}
