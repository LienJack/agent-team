import {
  receiptJsonSchema,
  runLogDir,
  taskBranch,
  taskWorktreePath,
  type ImplReceipt,
  type Project,
  type Run,
  type RunSpec,
  type Task,
  type Workspace,
} from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import { isPathOwned } from '../util/paths.js';
import type { EngineContext, Tx } from './context.js';
import { openAttention } from './attention.js';
import { enqueueEffect } from './effect-queue.js';
import { blockTask, retryLater } from './outcomes.js';
import { buildPrompt } from './prompt.js';
import { saveTask, saveWorkspace } from './records.js';
import { nextRunKind, type PlannedDispatch } from './scheduler.js';

export type DispatchReport =
  | { task_id: string; outcome: 'accepted'; run_id: string }
  | { task_id: string; outcome: 'rejected'; reason: string }
  | { task_id: string; outcome: 'deferred'; reason: string };

/**
 * Prepare and create one planned run (spec §8): ensure the worktree, check base drift (impl/fix),
 * then in one transaction create the run, move the task and enqueue `run.start`. The worktree is
 * created before its DB record; recovery removes worktrees without a record. "accepted" here
 * means the run.start effect is stored — the runner's own accept/reject/unknown follows.
 */
export async function dispatchPlanned(
  ctx: EngineContext,
  planned: PlannedDispatch,
): Promise<DispatchReport> {
  const { task } = planned;
  ctx.dispatching.set(task.id, planned.role);
  try {
    const project = ctx.store.projects.get(task.project_id);
    if (!project) return reject(ctx, task, `project ${task.project_id} missing`);
    let ws: Workspace;
    try {
      ws = await ensureWorkspace(ctx, task, project);
      if (planned.kind !== 'review') {
        const drift = await checkBaseDrift(ctx, task, project, ws);
        if (drift === 'blocked') {
          return { task_id: task.id, outcome: 'deferred', reason: 'base_drift_blocked' };
        }
        ws = drift;
      }
    } catch (err) {
      return reject(ctx, task, `workspace: ${errorMessage(err)}`);
    }
    const runId = ctx.transact((tx) => createRun(ctx, tx, planned, project, ws));
    if (runId === undefined) {
      return { task_id: task.id, outcome: 'deferred', reason: 'task_changed' };
    }
    ctx.humanPriority.delete(task.id);
    return { task_id: task.id, outcome: 'accepted', run_id: runId };
  } finally {
    ctx.dispatching.delete(task.id);
  }
}

async function ensureWorkspace(
  ctx: EngineContext,
  task: Task,
  project: Project,
): Promise<Workspace> {
  const existing = ctx.store.workspaces.findCurrentByTask(task.id);
  if (existing) return existing;
  const path = taskWorktreePath(ctx.config.worktreeRoot, project.name, task.id);
  const branch = taskBranch(task.id);
  const res = await ctx.deps.git.ensureWorktree({
    repoPath: project.repo_path,
    worktreePath: path,
    branch,
    baseBranch: project.base_branch,
  });
  return ctx.transact((tx) => {
    const again = tx.r.workspaces.findCurrentByTask(task.id);
    if (again) return again;
    const ws: Workspace = {
      id: ctx.newId('workspace'),
      task_id: task.id,
      path,
      branch,
      base_sha: res.baseSha,
      head_sha: null,
      state: 'active',
      created_at: tx.now,
      removed_at: null,
    };
    tx.r.workspaces.insert(ws);
    tx.emit(
      'workspace.created',
      { workspace_id: ws.id, path, branch, base_sha: ws.base_sha },
      { task_id: task.id },
    );
    return ws;
  });
}

/**
 * Base drift (spec §8): if `base_branch` moved since the worktree was created and the moved files
 * touch owned_paths, rebuild a pristine worktree on the new base, otherwise block the task with an
 * attention item. Neither consumes retry budget.
 */
async function checkBaseDrift(
  ctx: EngineContext,
  task: Task,
  project: Project,
  ws: Workspace,
): Promise<Workspace | 'blocked'> {
  const { git } = ctx.deps;
  const tip = await git.resolveRef({ repoPath: project.repo_path, ref: project.base_branch });
  if (tip === ws.base_sha) return ws;
  const files = await git.diffFiles({
    repoPath: project.repo_path,
    fromSha: ws.base_sha,
    toSha: tip,
  });
  const relevant = files.filter((f) => isPathOwned(f, task.owned_paths));
  if (relevant.length === 0) return ws;
  const status = await git.status({ worktreePath: ws.path });
  const pristine = status.clean && status.headSha === ws.base_sha && ws.head_sha === null;
  if (pristine) {
    await git.resetWorktree({ worktreePath: ws.path, toSha: tip });
    return ctx.transact((tx) => {
      const current = tx.r.workspaces.get(ws.id) ?? ws;
      const next = saveWorkspace(tx, current, { base_sha: tip });
      tx.emit('workspace.rebased', { workspace_id: ws.id, base_sha: tip }, { task_id: task.id });
      tx.emit(
        'task.base_drift',
        { action: 'rebuilt', base_sha: ws.base_sha, new_base_sha: tip, files: relevant },
        { task_id: task.id },
      );
      return next;
    });
  }
  ctx.transact((tx) => {
    const current = tx.r.tasks.get(task.id);
    if (!current || current.version !== task.version) return;
    tx.emit(
      'task.base_drift',
      { action: 'blocked', base_sha: ws.base_sha, new_base_sha: tip, files: relevant },
      { task_id: task.id },
    );
    blockTask(ctx, tx, current, `基底分支 ${project.base_branch} 已變動且影響 owned_paths`);
    openAttention(ctx, tx, {
      task_id: task.id,
      kind: 'decision',
      question: `${task.title}（${task.id}）的基底分支已變動並影響 ${relevant.length} 個 owned 檔案，worktree 已有修改；要重建還是照舊繼續？`,
      options: ['重建 worktree', '照舊繼續'],
    });
  });
  return 'blocked';
}

function lastImplReceipt(tx: Tx, taskId: string): ImplReceipt | null {
  const runs = tx.r.runs.list({ task_id: taskId }).filter((r) => r.kind !== 'review');
  const receipt = runs[runs.length - 1]?.receipt;
  return receipt && 'status' in receipt ? receipt : null;
}

function createRun(
  ctx: EngineContext,
  tx: Tx,
  planned: PlannedDispatch,
  project: Project,
  ws: Workspace,
): string | undefined {
  const task = tx.r.tasks.get(planned.task.id);
  // the task may have changed while the worktree was prepared
  if (!task || task.version !== planned.task.version || nextRunKind(task) !== planned.kind) {
    return undefined;
  }
  const { resolved, kind } = planned;
  const runId = ctx.newId('run');
  const dispatchId = ctx.newId('dispatch');
  const receiptSchema = receiptJsonSchema(kind === 'review' ? 'review' : 'impl');
  const logDir = runLogDir(ctx.config.dataDir, runId);
  const prompt = buildPrompt({
    kind,
    task,
    project,
    workspace: ws,
    dispatchId,
    receiptSchema,
    implReceipt: kind === 'review' ? lastImplReceipt(tx, task.id) : null,
  });
  const spec: RunSpec = {
    dispatchId,
    cwd: ws.path,
    prompt,
    schema: receiptSchema,
    model: resolved.model,
    writable: kind !== 'review',
    logDir,
    timeoutMs: ctx.config.engine.run_timeout_ms,
  };
  if (resolved.effort !== undefined) spec.effort = resolved.effort;
  const run: Run = {
    id: runId,
    task_id: task.id,
    workspace_id: ws.id,
    dispatch_id: dispatchId,
    kind,
    role: planned.role,
    model_alias: resolved.alias,
    runner: resolved.runner,
    model: resolved.model,
    state: 'starting',
    outcome: null,
    reject_reason: null,
    error: null,
    session_ref: null,
    receipt: null,
    usage: null,
    cost_usd: null,
    log_dir: logDir,
    pid: null,
    started_at: tx.now,
    ended_at: null,
  };
  tx.r.runs.insert(run);
  tx.emit(
    'run.created',
    {
      kind,
      role: run.role,
      model_alias: run.model_alias,
      runner: run.runner,
      model: run.model,
      dispatch_id: dispatchId,
    },
    { task_id: task.id, run_id: runId },
  );
  saveTask(
    tx,
    task,
    {
      status: kind === 'review' ? 'review' : 'running',
      current_run_id: runId,
      retry_at: null,
      // the note is in this prompt now; clear it so it is not repeated
      recovery_note: null,
    },
    `dispatched ${kind} run ${runId}`,
  );
  enqueueEffect(tx, 'run.start', runId, { run_id: runId, spec });
  return runId;
}

/** Dispatch failed before any run existed (worktree/git problem): consume an attempt. */
function reject(ctx: EngineContext, task: Task, reason: string): DispatchReport {
  ctx.transact((tx) => {
    const current = tx.r.tasks.get(task.id);
    const kind = current ? nextRunKind(current) : undefined;
    if (!current || current.version !== task.version || kind === undefined) return;
    const next = retryLater(ctx, tx, current, kind, { countAttempt: true, reason });
    tx.emit(
      'task.dispatch_failed',
      { reason, attempts: next.attempts, retry_at: next.retry_at },
      { task_id: task.id },
    );
  });
  return { task_id: task.id, outcome: 'rejected', reason };
}
