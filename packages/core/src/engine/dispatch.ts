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
import { isWorktreeIntegrityError, type ReviewDiff } from '../ports/git.js';
import { answersFor } from './answers.js';
import type { EngineContext, Tx } from './context.js';
import { checkBaseDrift } from './drift.js';
import { enqueueEffect } from './effect-queue.js';
import { blockForIntegrity, worktreeRef } from './integrity.js';
import { retryLater } from './outcomes.js';
import { buildPrompt, REVIEW_DIFF_MAX_CHARS } from './prompt.js';
import { saveTask } from './records.js';
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
  ctx.dispatchingRunners.set(task.id, planned.resolved.runner);
  try {
    const project = ctx.store.projects.get(task.project_id);
    if (!project) return reject(ctx, task, `project ${task.project_id} missing`);
    let ws: Workspace;
    try {
      ws = await ensureWorkspace(ctx, task, project);
      if (planned.kind !== 'review') {
        const ignoreCase = await projectIgnoresCase(ctx, project);
        const drift = await checkBaseDrift(ctx, task, project, ws, ignoreCase);
        if (drift === 'blocked') {
          return { task_id: task.id, outcome: 'deferred', reason: 'base_drift_blocked' };
        }
        ws = drift;
        // never send a worker into a worktree that is not what the records say (docs/adr/0018)
        await ctx.deps.git.status(worktreeRef(project, ws));
      }
    } catch (err) {
      if (isWorktreeIntegrityError(err)) return integrity(ctx, task, err);
      return reject(ctx, task, `workspace: ${errorMessage(err)}`);
    }
    // read-only reviewers cannot run git: the diff goes into the prompt (docs/adr/0008)
    let reviewDiff: ReviewDiff | null = null;
    if (planned.kind === 'review' && ws.head_sha !== null) {
      try {
        reviewDiff = await ctx.deps.git.reviewDiff({
          ...worktreeRef(project, ws),
          baseSha: ws.base_sha,
          headSha: ws.head_sha,
          maxChars: REVIEW_DIFF_MAX_CHARS,
        });
      } catch (err) {
        if (isWorktreeIntegrityError(err)) return integrity(ctx, task, err);
        return reject(ctx, task, `review diff: ${errorMessage(err)}`);
      }
    }
    const runId = ctx.transact((tx) => createRun(ctx, tx, planned, project, ws, reviewDiff));
    if (runId === undefined) {
      return { task_id: task.id, outcome: 'deferred', reason: 'task_changed' };
    }
    ctx.humanPriority.delete(task.id);
    return { task_id: task.id, outcome: 'accepted', run_id: runId };
  } finally {
    ctx.dispatching.delete(task.id);
    ctx.dispatchingRunners.delete(task.id);
  }
}

/**
 * Whether the project's filesystem compares names case-insensitively (cached per project). An
 * error counts as case-insensitive: overlaps and ownership then err on the strict side.
 */
export async function projectIgnoresCase(ctx: EngineContext, project: Project): Promise<boolean> {
  const cached = ctx.caseInsensitive.get(project.id);
  if (cached !== undefined) return cached;
  let value = true;
  try {
    value = await ctx.deps.git.ignoresCase({ repoPath: project.repo_path });
  } catch (err) {
    ctx.logger.warn('cannot read core.ignorecase', {
      project: project.name,
      error: errorMessage(err),
    });
  }
  ctx.caseInsensitive.set(project.id, value);
  return value;
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
      accepted_base_sha: null,
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
  reviewDiff: ReviewDiff | null,
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
    reviewDiff,
    answers: answersFor(tx, task.id),
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
    // the runner adds the service-wide deny list (DATA, the service .env, credentials)
    sandbox: { allowNetwork: project.allow_network, repoPath: project.repo_path },
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
    cost_estimated: false,
    log_dir: logDir,
    pid: null,
    pid_started_at: null,
    launched_at: null,
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

/** The worktree failed its identity check (docs/adr/0018): blocked for a human, no attempt used. */
function integrity(
  ctx: EngineContext,
  task: Task,
  err: Parameters<typeof blockForIntegrity>[3],
): DispatchReport {
  ctx.transact((tx) => {
    const current = tx.r.tasks.get(task.id);
    if (current && current.version === task.version) blockForIntegrity(ctx, tx, task.id, err);
  });
  return { task_id: task.id, outcome: 'rejected', reason: `worktree_integrity: ${err.reason}` };
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
