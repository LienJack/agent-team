import { errorMessage } from '../errors.js';
import { addMs } from '../util/time.js';
import type { EngineContext, Tx } from './context.js';
import { enqueueEffect } from './effect-queue.js';
import { recoveryNoteFor } from './prompt.js';
import { finishRun, saveTask } from './records.js';

export interface RecoveryReport {
  abandonedRuns: string[];
  requeuedTasks: string[];
  orphanWorktrees: string[];
  pendingEffects: number;
  clearedIdempotency: number;
}

/**
 * Startup recovery (spec §8). Run once before the first tick:
 * 1. runs left `starting`/`running` → `abandoned`; their tasks go back to `queued` (impl/fix) or
 *    stay in `review` (review runs — the committed work is intact) with a recovery note for the
 *    next prompt;
 * 2. pending idempotency records are dropped (nothing can still be processing them);
 * 3. worktrees under the worktree root with no workspace record get a `workspace.remove` effect
 *    (forced: nothing references them; docs/adr/0009);
 * 4. unfinished effects simply run again (start effects of abandoned runs become no-ops).
 */
/**
 * Every live (`starting`/`running`) run → `abandoned`; its task goes back to `queued` (impl/fix)
 * or stays in `review` (review run), with a recovery note for the next prompt and attempts
 * unchanged. Used by startup recovery and by a graceful shutdown (after the worker process
 * groups were terminated), so a clean stop leaves nothing for the next start to repair.
 */
export function abandonLiveRuns(
  tx: Tx,
  why: 'restart' | 'shutdown',
): { abandonedRuns: string[]; requeuedTasks: string[] } {
  const abandonedRuns: string[] = [];
  const requeuedTasks: string[] = [];
  const error = why === 'restart' ? 'abandoned: service restarted' : 'abandoned: service stopped';
  for (const run of tx.r.runs.list({ states: ['starting', 'running'] })) {
    finishRun(tx, run, { state: 'abandoned', error });
    abandonedRuns.push(run.id);
    const task = tx.r.tasks.get(run.task_id);
    if (!task || task.current_run_id !== run.id) continue;
    saveTask(
      tx,
      task,
      {
        status: run.kind === 'review' ? task.status : 'queued',
        current_run_id: null,
        retry_at: null,
        recovery_note: recoveryNoteFor(run.id, run.dispatch_id, run.kind),
      },
      why === 'restart'
        ? `recovered after restart (run ${run.id} abandoned)`
        : `service stopped (run ${run.id} abandoned)`,
    );
    requeuedTasks.push(task.id);
  }
  return { abandonedRuns, requeuedTasks };
}

export async function recover(ctx: EngineContext): Promise<RecoveryReport> {
  const report = ctx.transact((tx) => {
    const { abandonedRuns, requeuedTasks } = abandonLiveRuns(tx, 'restart');
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
    return { abandonedRuns, requeuedTasks, clearedIdempotency };
  });

  const orphanWorktrees: string[] = [];
  for (const project of ctx.store.projects.list()) {
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
      orphan_worktrees: orphanWorktrees.length,
      pending_effects: pendingEffects,
      cleared_idempotency: report.clearedIdempotency,
    });
    return { ...report, orphanWorktrees, pendingEffects };
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
