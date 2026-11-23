import {
  AttentionCreateRequestSchema,
  isHighRiskAttention,
  isLiveRunState,
  isTerminalTaskStatus,
  ProjectCreateRequestSchema,
  ProjectUpdateRequestSchema,
  TaskCreateRequestSchema,
  type AnswerVia,
  type Attention,
  type AttentionCreateRequest,
  type Project,
  type ProjectCreateRequest,
  type ProjectUpdateRequest,
  type Task,
  type TaskCreateRequest,
} from '@agent-team/schema';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import type { EngineContext, Tx } from './context.js';
import { isFixLimitBlock, resumeAfterAnswer } from './answers.js';
import { answerAttention, openAttention } from './attention.js';
import { applyAttentionAction, isBaseDriftBlock } from './drift.js';
import { WORKTREE_INTEGRITY_BLOCK } from './integrity.js';
import { enqueueEffect } from './effect-queue.js';
import { completeTask, requestFix } from './outcomes.js';
import { finishRun, lastRun, requireTask, saveTask } from './records.js';
import { checkResearchRefs, requireResearchEnabled } from './research.js';
import { haltedRunnerOf, rearmRunner } from './runner-health.js';
import { needsHumanRetry, WORKER_UNCONFIRMED_BLOCK } from './start-unknown.js';
import { rememberAnswer } from './project-memory.js';

// Human/leader commands (spec §11 task actions). Each runs in one transaction and checks the
// task's current status first (a clear 409 instead of a stranded task). A `human` actor marks
// the task so the scheduler may use the reserved slot for it (spec §8).
//
// Actors (docs/adr/0014): the server derives the actor from the credential — `human` (LAN
// session, operator token), `leader` (the leader-scoped token). Decisions that bypass review or
// change what runs where are human-only: approve, reject, answering attention items, reassign,
// project registration and settings, base-drift decisions and retries the leader is not trusted with.

export interface Actor {
  kind: 'human' | 'leader' | 'system';
}

const HUMAN: Actor = { kind: 'human' };

export function requireHuman(actor: Actor, what: string): void {
  if (actor.kind !== 'human') {
    throw new ForbiddenError(
      `${what} is a human decision (actor: ${actor.kind})`,
      'ask the person with `team attention open`',
    );
  }
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

export function createProject(
  ctx: EngineContext,
  input: ProjectCreateRequest,
  actor: Actor = HUMAN,
): Project {
  requireHuman(actor, 'registering a project');
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
      allow_network: req.allow_network,
      created_at: tx.now,
    };
    tx.r.projects.insert(project);
    tx.emit('project.created', { name: project.name });
    return project;
  });
}

/**
 * Replace a project's machine checks (humans only, like registration). Takes effect at the next
 * verification: a run already being verified keeps the list it started with.
 */
export function updateProject(
  ctx: EngineContext,
  projectId: string,
  input: ProjectUpdateRequest,
  actor: Actor = HUMAN,
): Project {
  requireHuman(actor, "changing a project's checks");
  const req = parse(ProjectUpdateRequestSchema, input);
  return ctx.transact((tx) => {
    const current = tx.r.projects.get(projectId);
    if (!current) throw new NotFoundError('project', projectId);
    const project: Project = { ...current, checks: req.checks };
    tx.r.projects.update(project);
    tx.emit('project.updated', { name: project.name, checks: req.checks.map((c) => c.name) });
    return project;
  });
}

export function createTask(ctx: EngineContext, input: TaskCreateRequest, actor: Actor): Task {
  const req = parse(TaskCreateRequestSchema, input);
  if (req.research_refs.length > 0) requireResearchEnabled(ctx, 'citing research');
  const task = ctx.transact((tx) => {
    if (!tx.r.projects.get(req.project_id)) throw new NotFoundError('project', req.project_id);
    if (req.parent_id !== undefined && !tx.r.tasks.get(req.parent_id)) {
      throw new NotFoundError('task', req.parent_id);
    }
    const refs = checkResearchRefs(tx.r, req.project_id, req.research_refs);
    const implRole = req.impl_role ?? `impl_${req.tier}`;
    if (!ctx.config.models.roles[implRole]) {
      throw new ValidationError(`unknown role ${implRole}`, 'see config/models.json roles');
    }
    const created: Task = {
      id: ctx.newId('task'),
      project_id: req.project_id,
      parent_id: req.parent_id ?? null,
      kind: 'impl',
      title: req.title,
      tier: req.tier,
      ticket_md: req.ticket_md,
      owned_paths: req.owned_paths,
      research_refs: refs,
      priority: req.priority,
      status: req.queue ? 'queued' : 'draft',
      impl_role: implRole,
      fix_rounds: 0,
      leader_retries: 0,
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

/** Queue a draft (only drafts: every other state has its own way back, e.g. retry). */
export function queueTask(ctx: EngineContext, id: string, actor: Actor): Task {
  const task = ctx.transact((tx) => {
    const current = requireTask(tx, id);
    if (current.status !== 'draft') {
      throw new ConflictError(
        `only draft tasks can be queued (task ${id} is ${current.status})`,
        current.status === 'blocked' || current.status === 'failed'
          ? 'use retry for blocked or failed tasks'
          : 'the task is already queued or in progress',
      );
    }
    return saveTask(tx, current, { status: 'queued' }, 'queued');
  });
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
 * waiting for a reviewer), otherwise to `queued`. A human retry resets attempts, backoff and the
 * leader's retry count. The leader (M6) may not retry a task whose worker may still be alive
 * (`start_unknown`, unconfirmed after a crash) or that exhausted its attempts (`failed`); its
 * retries keep `attempts` and count against `engine.leader_retry_budget` per task.
 */
export function retryTask(ctx: EngineContext, id: string, actor: Actor): Task {
  const task = ctx.transact((tx) => {
    const current = requireTask(tx, id);
    if (current.status !== 'blocked' && current.status !== 'failed') {
      throw new ConflictError(
        `only blocked or failed tasks can be retried (task ${id} is ${current.status})`,
      );
    }
    if (isBaseDriftBlock(current)) {
      throw new ConflictError(
        `task ${id} is blocked by a base drift; a retry would block again`,
        'answer its attention item: rebuild the worktree or continue on the old base',
      );
    }
    const last = lastRun(tx, id);
    const human = actor.kind === 'human';
    if (!human) {
      if (current.status === 'failed') {
        throw new ForbiddenError(`task ${id} exhausted its attempts; only a human can retry it`);
      }
      const blockedFor = current.blocked_reason ?? '';
      const why = blockedFor.startsWith(WORKER_UNCONFIRMED_BLOCK)
        ? 'a worker could not be confirmed dead after a restart'
        : blockedFor.startsWith(WORKTREE_INTEGRITY_BLOCK)
          ? 'its worktree failed the identity check (tampered .git?)'
          : needsHumanRetry(last);
      if (why !== null) throw new ForbiddenError(`task ${id}: ${why}; only a human can retry it`);
      const budget = ctx.config.engine.leader_retry_budget;
      if (current.leader_retries >= budget) {
        throw new ForbiddenError(
          `task ${id} used its ${budget} leader retries; a human has to decide`,
          'open an attention item for the person',
        );
      }
    }
    // a person retrying is a person deciding to try again: re-arm the runners the loop guard
    // stopped that this task would use (docs/adr/0022)
    if (human) {
      const usable = runnersOfTask(ctx, current);
      for (const runner of ctx.deps.runners.names())
        if (usable.has(runner)) rearmRunner(tx, runner);
    }
    const ws = tx.r.workspaces.findCurrentByTask(id);
    const backToReview =
      last?.kind === 'review' && current.fix_notes === null && ws?.head_sha != null;
    return saveTask(
      tx,
      current,
      {
        status: backToReview ? 'review' : 'queued',
        ...(human
          ? { attempts: 0, leader_retries: 0 }
          : { leader_retries: current.leader_retries + 1 }),
        // a person retrying a task that ran out of fix rounds gives it a fresh budget
        ...(human && isFixLimitBlock(current) ? { fix_rounds: 0 } : {}),
        retry_at: null,
        blocked_reason: null,
        current_run_id: null,
      },
      human ? 'retry' : 'retry (leader)',
    );
  });
  prioritize(ctx, id, actor);
  return task;
}

/** Human acceptance of a task in review (overrides a pending model review). */
export function approveTask(
  ctx: EngineContext,
  id: string,
  reason = 'approved by human',
  actor: Actor = HUMAN,
): Task {
  requireHuman(actor, 'approving a task');
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
  requireHuman(actor, 'rejecting a task');
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
  requireHuman(actor, 'reassigning a task');
  const roleCfg = ctx.config.models.roles[role];
  if (!roleCfg || !roleCfg.enabled) throw new ValidationError(`unknown or disabled role ${role}`);
  const task = ctx.transact((tx) => {
    const current = requireTask(tx, id);
    if (current.kind === 'research') {
      throw new ConflictError(
        `task ${id} is a research task; its role is fixed`,
        'research runs always use the oss_researcher role (config/models.json)',
      );
    }
    if (isTerminalTaskStatus(current.status)) {
      throw new ConflictError(`task ${id} is already ${current.status}`);
    }
    if (current.current_run_id !== null || current.status === 'verifying') {
      throw new ConflictError(`task ${id} has a run in progress`, 'cancel or wait for it first');
    }
    if (isBaseDriftBlock(current)) {
      throw new ConflictError(
        `task ${id} is blocked by a base drift`,
        'answer its attention item first (rebuild or continue)',
      );
    }
    const requeue = current.status === 'blocked' || current.status === 'failed';
    return saveTask(
      tx,
      current,
      {
        impl_role: role,
        fix_rounds: 0,
        ...(requeue
          ? {
              status: 'queued' as const,
              attempts: 0,
              leader_retries: 0,
              retry_at: null,
              blocked_reason: null,
            }
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
      topic: 'general',
      question: req.question,
      options: req.options,
    });
  });
}

/**
 * Record a human's answer. Items the engine opened with a known action (base drift: rebuild or
 * continue) apply the chosen option in the same transaction; answering the last open question of
 * a task its worker blocked queues the task again, and every answer reaches the next prompt.
 */
export function answer(
  ctx: EngineContext,
  id: string,
  text: string,
  via: AnswerVia,
  actor: Actor = HUMAN,
): Attention {
  requireHuman(actor, 'answering an attention item');
  return ctx.transact((tx) => {
    const open = tx.r.attention.get(id);
    // high-risk decisions (discarding work, bypassing a safety stop) are answered where the
    // person can see the task: the board or the CLI, never a chat button (docs/adr/0022)
    if (open && via === 'grok' && isHighRiskAttention(open)) {
      throw new ForbiddenError(
        `attention ${id} (${open.topic}) can only be answered from the board or the CLI`,
        `team attention answer ${id} "<option>"`,
      );
    }
    const item = answerAttention(tx, id, text, via);
    // a person's decision becomes project memory (spec §18; decisions and worker questions only)
    rememberAnswer(ctx, tx, item);
    applyAttentionAction(ctx, tx, item);
    resumeAfterAnswer(ctx, tx, item);
    // any answer to the loop guard's item re-arms its runner
    if (item.topic === 'runner_halted') {
      const runner = haltedRunnerOf(tx.r.kv, ctx.deps.runners, item.id);
      if (runner !== undefined) rearmRunner(tx, runner);
    }
    return item;
  });
}

/** Runners a task's next runs may use: every alias of its impl, review or research role. */
function runnersOfTask(ctx: EngineContext, task: Task): Set<string> {
  // a research task's impl_role is oss_researcher; it has no review run
  const roles =
    task.kind === 'research' ? [task.impl_role] : [task.impl_role, `review_${task.tier}`];
  const runners = new Set<string>();
  for (const role of roles) {
    const entry = ctx.config.models.roles[role];
    if (!entry) continue;
    for (const alias of [entry.use, ...entry.fallback]) {
      const runner = ctx.config.models.models[alias]?.runner;
      if (runner !== undefined) runners.add(runner);
    }
  }
  return runners;
}
