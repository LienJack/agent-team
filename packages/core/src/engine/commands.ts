import {
  AttentionCreateRequestSchema,
  isLiveRunState,
  isTerminalTaskStatus,
  ProjectCreateRequestSchema,
  TaskCreateRequestSchema,
  type AnswerVia,
  type Attention,
  type AttentionCreateRequest,
  type Project,
  type ProjectCreateRequest,
  type Task,
  type TaskCreateRequest,
} from '@agent-team/schema';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { EngineContext, Tx } from './context.js';
import { answerAttention, openAttention } from './attention.js';
import { enqueueEffect } from './effect-queue.js';
import { completeTask, requestFix } from './outcomes.js';
import { finishRun, lastRun, requireTask, saveTask } from './records.js';

// Human/leader commands (spec §11 task actions). Each runs in one transaction. A `human` actor
// marks the task so the scheduler may use the reserved slot for it (spec §8).

export interface Actor {
  kind: 'human' | 'leader' | 'system';
}

interface SafeParser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> };
      };
}

function parse<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ValidationError(
    issue
      ? `${issue.path.map(String).join('.') || 'request'}: ${issue.message}`
      : 'invalid request',
  );
}

function prioritize(ctx: EngineContext, taskId: string, actor: Actor): void {
  if (actor.kind === 'human') ctx.humanPriority.add(taskId);
}

export function createProject(ctx: EngineContext, input: ProjectCreateRequest): Project {
  const req = parse(ProjectCreateRequestSchema, input);
  return ctx.transact((tx) => {
    if (tx.r.projects.getByName(req.name)) {
      throw new ConflictError(`project ${req.name} already exists`);
    }
    const project: Project = {
      id: ctx.newId('project'),
      name: req.name,
      repo_path: req.repo_path,
      base_branch: req.base_branch,
      checks: req.checks,
      created_at: tx.now,
    };
    tx.r.projects.insert(project);
    tx.emit('project.created', { name: project.name });
    return project;
  });
}

export function createTask(ctx: EngineContext, input: TaskCreateRequest, actor: Actor): Task {
  const req = parse(TaskCreateRequestSchema, input);
  const task = ctx.transact((tx) => {
    if (!tx.r.projects.get(req.project_id)) throw new NotFoundError('project', req.project_id);
    if (req.parent_id !== undefined && !tx.r.tasks.get(req.parent_id)) {
      throw new NotFoundError('task', req.parent_id);
    }
    const implRole = req.impl_role ?? `impl_${req.tier}`;
    if (!ctx.config.models.roles[implRole]) {
      throw new ValidationError(`unknown role ${implRole}`, 'see config/models.json roles');
    }
    const created: Task = {
      id: ctx.newId('task'),
      project_id: req.project_id,
      parent_id: req.parent_id ?? null,
      title: req.title,
      tier: req.tier,
      ticket_md: req.ticket_md,
      owned_paths: req.owned_paths,
      priority: req.priority,
      status: req.queue ? 'queued' : 'draft',
      impl_role: implRole,
      fix_rounds: 0,
      attempts: 0,
      blocked_reason: null,
      version: 1,
      current_run_id: null,
      retry_at: null,
      fix_notes: null,
      recovery_note: null,
      created_at: tx.now,
      updated_at: tx.now,
    };
    tx.r.tasks.insert(created);
    tx.emit(
      'task.created',
      { title: created.title, status: created.status },
      { task_id: created.id },
    );
    return created;
  });
  if (task.status === 'queued') prioritize(ctx, task.id, actor);
  return task;
}

export function queueTask(ctx: EngineContext, id: string, actor: Actor): Task {
  const task = ctx.transact((tx) =>
    saveTask(tx, requireTask(tx, id), { status: 'queued' }, 'queued'),
  );
  prioritize(ctx, id, actor);
  return task;
}

/** Stop the task's live run (if any): mark it stopped now and abort it via `run.stop`. */
function stopCurrentRun(tx: Tx, task: Task, reason: string): void {
  if (task.current_run_id === null) return;
  const run = tx.r.runs.get(task.current_run_id);
  if (!run || !isLiveRunState(run.state)) return;
  finishRun(tx, run, { state: 'stopped', outcome: 'cancelled', error: `cancelled: ${reason}` });
  enqueueEffect(tx, 'run.stop', run.id, { run_id: run.id, reason });
}

export function cancelTask(ctx: EngineContext, id: string, reason = 'cancelled'): Task {
  return ctx.transact((tx) => {
    const task = requireTask(tx, id);
    if (isTerminalTaskStatus(task.status)) {
      throw new ConflictError(`task ${id} is already ${task.status}`);
    }
    // a pending verification is fenced off by current_run_id and becomes a no-op
    stopCurrentRun(tx, task, reason);
    // the worktree stays `active` until the cleanup sweep (docs/adr/0009)
    return saveTask(tx, task, { status: 'cancelled', current_run_id: null }, reason);
  });
}

/**
 * Retry a blocked/failed task: back to `review` when it stopped during review (committed work
 * waiting for a reviewer), otherwise to `queued`. Resets attempts and backoff.
 */
export function retryTask(ctx: EngineContext, id: string, actor: Actor): Task {
  const task = ctx.transact((tx) => {
    const current = requireTask(tx, id);
    if (current.status !== 'blocked' && current.status !== 'failed') {
      throw new ConflictError(
        `only blocked or failed tasks can be retried (task is ${current.status})`,
      );
    }
    const ws = tx.r.workspaces.findCurrentByTask(id);
    const backToReview =
      lastRun(tx, id)?.kind === 'review' && current.fix_notes === null && ws?.head_sha != null;
    return saveTask(
      tx,
      current,
      {
        status: backToReview ? 'review' : 'queued',
        attempts: 0,
        retry_at: null,
        blocked_reason: null,
        current_run_id: null,
      },
      'retry',
    );
  });
  prioritize(ctx, id, actor);
  return task;
}

/** Human acceptance of a task in review (overrides a pending model review). */
export function approveTask(ctx: EngineContext, id: string, reason = 'approved by human'): Task {
  return ctx.transact((tx) => {
    const task = requireTask(tx, id);
    if (task.status !== 'review')
      throw new ConflictError(`task ${id} is ${task.status}, not review`);
    stopCurrentRun(tx, task, 'approved');
    return completeTask(ctx, tx, task, reason);
  });
}

/** Human rejection of a task in review: the note becomes the fix run's must-fix list. */
export function rejectTask(ctx: EngineContext, id: string, note: string, actor: Actor): Task {
  if (note.trim() === '') throw new ValidationError('note must not be empty');
  const task = ctx.transact((tx) => {
    const current = requireTask(tx, id);
    if (current.status !== 'review') {
      throw new ConflictError(`task ${id} is ${current.status}, not review`);
    }
    stopCurrentRun(tx, current, 'rejected by human');
    return requestFix(ctx, tx, current, `人工退回：${note.trim()}`, 'human_reject');
  });
  prioritize(ctx, id, actor);
  return task;
}

/**
 * Change the role for the next impl/fix run (fresh fix budget). Not allowed while a run of the
 * task is in flight; a blocked/failed task is queued again.
 */
export function reassignTask(ctx: EngineContext, id: string, role: string, actor: Actor): Task {
  const roleCfg = ctx.config.models.roles[role];
  if (!roleCfg || !roleCfg.enabled) throw new ValidationError(`unknown or disabled role ${role}`);
  const task = ctx.transact((tx) => {
    const current = requireTask(tx, id);
    if (isTerminalTaskStatus(current.status)) {
      throw new ConflictError(`task ${id} is already ${current.status}`);
    }
    if (current.current_run_id !== null || current.status === 'verifying') {
      throw new ConflictError(`task ${id} has a run in progress`, 'cancel or wait for it first');
    }
    const requeue = current.status === 'blocked' || current.status === 'failed';
    return saveTask(
      tx,
      current,
      {
        impl_role: role,
        fix_rounds: 0,
        ...(requeue
          ? { status: 'queued' as const, attempts: 0, retry_at: null, blocked_reason: null }
          : {}),
      },
      `reassigned to ${role}`,
    );
  });
  prioritize(ctx, id, actor);
  return task;
}

export function createAttention(ctx: EngineContext, input: AttentionCreateRequest): Attention {
  const req = parse(AttentionCreateRequestSchema, input);
  return ctx.transact((tx) => {
    if (req.task_id !== undefined && !tx.r.tasks.get(req.task_id)) {
      throw new NotFoundError('task', req.task_id);
    }
    return openAttention(ctx, tx, {
      task_id: req.task_id ?? null,
      kind: req.kind,
      question: req.question,
      options: req.options,
    });
  });
}

export function answer(ctx: EngineContext, id: string, text: string, via: AnswerVia): Attention {
  return ctx.transact((tx) => answerAttention(tx, id, text, via));
}
