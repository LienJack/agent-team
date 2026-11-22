import type { Attention, Project, Task, Workspace } from '@agent-team/schema';
import { ConflictError, ValidationError } from '../errors.js';
import { isPathOwned } from '../util/paths.js';
import type { EngineContext, Tx } from './context.js';
import { openAttention } from './attention.js';
import { effectPayload, enqueueEffect, type EffectHandler } from './effect-queue.js';
import { blockTask } from './outcomes.js';
import { saveTask, saveWorkspace } from './records.js';

// Base drift (spec §8 派工前檢查, M5): the base branch moved since the worktree was created and
// the moved files touch owned_paths. A pristine worktree is moved to the new tip; otherwise the
// task is blocked with one attention item whose two options are real commands:
// - rebuild (`rebuildWorkspace`): discard the worktree, recreate it on the new tip and requeue the
//   task as a fresh impl (a durable `workspace.rebuild` effect, so a crash cannot lose it);
// - continue (`acceptNewBase`): record the tip as accepted and dispatch again on the old base.
//   `base_sha` stays the fork point: the diff, the ownership check and the review all compare
//   against it, so moving it without moving HEAD would count the base's own changes as the
//   worker's (docs/adr/0004 addendum).
// A plain retry of such a block is refused (it would only block again).

export const BASE_DRIFT_PREFIX = 'base_drift:';
export const DRIFT_OPTIONS = ['重建 worktree', '照舊繼續'] as const;

const actionKey = (attentionId: string) => `attention_action:${attentionId}`;

interface DriftAction {
  action: 'base_drift';
  task_id: string;
  workspace_id: string;
  new_base_sha: string;
}

export function isBaseDriftBlock(task: Task): boolean {
  return task.status === 'blocked' && (task.blocked_reason ?? '').startsWith(BASE_DRIFT_PREFIX);
}

/**
 * Check before an impl/fix dispatch. Returns the workspace to use, or `'blocked'`. Neither path
 * consumes retry budget.
 */
export async function checkBaseDrift(
  ctx: EngineContext,
  task: Task,
  project: Project,
  ws: Workspace,
  ignoreCase: boolean,
): Promise<Workspace | 'blocked'> {
  const { git } = ctx.deps;
  const tip = await git.resolveRef({ repoPath: project.repo_path, ref: project.base_branch });
  const known = ws.accepted_base_sha ?? ws.base_sha;
  if (tip === known || tip === ws.base_sha) return ws;
  const files = await git.diffFiles({ repoPath: project.repo_path, fromSha: known, toSha: tip });
  const relevant = files.filter((f) => isPathOwned(f, task.owned_paths, { ignoreCase }));
  if (relevant.length === 0) return ws;
  const ref = { worktreePath: ws.path, repoPath: project.repo_path, branch: ws.branch };
  const status = await git.status(ref);
  // HEAD already at the tip = a crash after the reset but before `base_sha` was saved
  const atTip = status.headSha === tip;
  const pristine =
    status.clean && ws.head_sha === null && (status.headSha === ws.base_sha || atTip);
  if (pristine) {
    if (!atTip) await git.resetWorktree({ ...ref, toSha: tip });
    return ctx.transact((tx) => {
      const current = tx.r.workspaces.get(ws.id) ?? ws;
      const next = saveWorkspace(tx, current, { base_sha: tip, accepted_base_sha: null });
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
    blockTask(
      ctx,
      tx,
      current,
      `${BASE_DRIFT_PREFIX} 基底分支 ${project.base_branch} 已變動且影響 owned_paths`,
    );
    const item = openAttention(ctx, tx, {
      task_id: task.id,
      kind: 'decision',
      topic: 'base_drift',
      question: `${task.title}（${task.id}）的基底分支已變動並影響 ${relevant.length} 個 owned 檔案，worktree 已有修改；要重建（捨棄 worktree，在新基底上重新實作）還是照舊繼續（留在舊基底）？`,
      options: [...DRIFT_OPTIONS],
    });
    const action: DriftAction = {
      action: 'base_drift',
      task_id: task.id,
      workspace_id: ws.id,
      new_base_sha: tip,
    };
    tx.r.kv.set(actionKey(item.id), JSON.stringify(action));
  });
  return 'blocked';
}

function readAction(tx: Tx, attentionId: string): DriftAction | undefined {
  const raw = tx.r.kv.get(actionKey(attentionId));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DriftAction>;
    return parsed.action === 'base_drift' ? (parsed as DriftAction) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply the action of an answered attention item, if the engine attached one. The answer must be
 * one of its options (anything else would leave the task stuck).
 */
export function applyAttentionAction(ctx: EngineContext, tx: Tx, item: Attention): void {
  const action = readAction(tx, item.id);
  if (!action) return;
  const task = tx.r.tasks.get(action.task_id);
  if (!task || !isBaseDriftBlock(task)) {
    tx.r.kv.delete(actionKey(item.id));
    return;
  }
  if (item.answer === DRIFT_OPTIONS[0]) rebuildWorkspace(ctx, tx, task, action);
  else if (item.answer === DRIFT_OPTIONS[1]) acceptNewBase(tx, task, action);
  else {
    throw new ValidationError(
      `answer must be one of: ${DRIFT_OPTIONS.join(' / ')}`,
      'this item decides how the task continues',
    );
  }
  tx.r.kv.delete(actionKey(item.id));
}

/** The open base-drift attention item of a task (for the explicit commands). */
export function openDriftItem(tx: Tx, taskId: string): Attention {
  for (const item of tx.r.attention.list({ task_id: taskId, statuses: ['open'] })) {
    if (readAction(tx, item.id)) return item;
  }
  throw new ConflictError(`task ${taskId} has no open base-drift decision`);
}

function rebuildWorkspace(ctx: EngineContext, tx: Tx, task: Task, action: DriftAction): void {
  enqueueEffect(tx, 'workspace.rebuild', action.workspace_id, {
    task_id: task.id,
    workspace_id: action.workspace_id,
  });
  saveTask(
    tx,
    task,
    { blocked_reason: `${BASE_DRIFT_PREFIX} 正在新基底上重建 worktree` },
    'rebuild requested',
  );
  ctx.logger.info('worktree rebuild requested', { task_id: task.id });
}

function acceptNewBase(tx: Tx, task: Task, action: DriftAction): void {
  const ws = tx.r.workspaces.get(action.workspace_id);
  if (!ws) throw new ConflictError(`workspace ${action.workspace_id} is gone`);
  saveWorkspace(tx, ws, { accepted_base_sha: action.new_base_sha });
  tx.emit(
    'task.base_drift',
    { action: 'accepted', base_sha: ws.base_sha, new_base_sha: action.new_base_sha, files: [] },
    { task_id: task.id },
  );
  saveTask(
    tx,
    task,
    { status: 'queued', blocked_reason: null, retry_at: null, current_run_id: null },
    'continue on the old base (drift accepted)',
  );
}

/**
 * `workspace.rebuild`: recreate the worktree on the current base tip, then requeue the task as a
 * fresh impl (fix rounds, notes and counters cleared). Git is idempotent, so a crash between the
 * rebuild and the finalizer just runs it again.
 */
export const rebuildHandler: EffectHandler = {
  async run(ctx, effect) {
    const p = effectPayload(effect, 'workspace.rebuild');
    const task = ctx.store.tasks.get(p.task_id);
    const ws = ctx.store.workspaces.get(p.workspace_id);
    const project = task ? ctx.store.projects.get(task.project_id) : undefined;
    if (!task || !ws || !project || !isBaseDriftBlock(task)) return undefined;
    const { baseSha } = await ctx.deps.git.rebuildWorktree({
      repoPath: project.repo_path,
      worktreePath: ws.path,
      branch: ws.branch,
      baseBranch: project.base_branch,
    });
    return (tx) => {
      const t = tx.r.tasks.get(p.task_id);
      const w = tx.r.workspaces.get(p.workspace_id);
      if (!t || !w || !isBaseDriftBlock(t)) return;
      saveWorkspace(tx, w, { base_sha: baseSha, head_sha: null, accepted_base_sha: null });
      tx.emit('workspace.rebased', { workspace_id: w.id, base_sha: baseSha }, { task_id: t.id });
      tx.emit(
        'task.base_drift',
        { action: 'rebuilt', base_sha: w.base_sha, new_base_sha: baseSha, files: [] },
        { task_id: t.id },
      );
      saveTask(
        tx,
        t,
        {
          status: 'queued',
          fix_rounds: 0,
          fix_notes: null,
          attempts: 0,
          leader_retries: 0,
          retry_at: null,
          blocked_reason: null,
          recovery_note: null,
          current_run_id: null,
        },
        `worktree rebuilt on ${baseSha}`,
      );
    };
  },
  onDead(ctx, tx, effect, error) {
    const p = effectPayload(effect, 'workspace.rebuild');
    const task = tx.r.tasks.get(p.task_id);
    if (task && isBaseDriftBlock(task)) blockTask(ctx, tx, task, `重建 worktree 失敗：${error}`);
  },
};
