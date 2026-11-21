import type { Project, Task, Workspace } from '@agent-team/schema';
import type { WorktreeIntegrityError, WorktreeRef } from '../ports/git.js';
import { openAttention } from './attention.js';
import type { EngineContext, Tx } from './context.js';
import { blockTask } from './outcomes.js';
import { saveRun } from './records.js';

// A worktree that fails the git port's identity check (docs/adr/0018: a rewritten `.git` pointer,
// HEAD off the task branch, …) is never worked in again automatically: the run (if any) is
// rejected, nothing is committed, the task is blocked and a human gets one attention item. Only a
// human can retry it (after inspecting or repairing the worktree, e.g. `git worktree repair` run
// in the primary checkout WITHOUT a path: with the worktree's path it follows the tampered pointer).

/** Prefix of `blocked_reason` for a failed worktree identity check (human retry only). */
export const WORKTREE_INTEGRITY_BLOCK = 'worktree_integrity:';

export function worktreeRef(project: Project, ws: Workspace): WorktreeRef {
  return { worktreePath: ws.path, repoPath: project.repo_path, branch: ws.branch };
}

export function isIntegrityBlock(task: Task): boolean {
  return (
    task.status === 'blocked' && (task.blocked_reason ?? '').startsWith(WORKTREE_INTEGRITY_BLOCK)
  );
}

/** Block `taskId` (and reject `runId`, if given) for a failed identity check, in `tx`. */
export function blockForIntegrity(
  ctx: EngineContext,
  tx: Tx,
  taskId: string,
  err: WorktreeIntegrityError,
  runId?: string,
): void {
  const reason = `${WORKTREE_INTEGRITY_BLOCK} ${err.reason}`;
  if (runId !== undefined) {
    const run = tx.r.runs.get(runId);
    if (run && run.outcome === null) {
      saveRun(tx, run, { outcome: 'rejected', reject_reason: reason });
      tx.emit(
        'run.verified',
        { outcome: 'rejected', reject_reason: reason, checks: [] },
        { task_id: run.task_id, run_id: run.id },
      );
    }
  }
  const task = tx.r.tasks.get(taskId);
  if (!task || isIntegrityBlock(task)) return;
  if (!(['done', 'cancelled', 'blocked', 'failed'] as const).some((s) => s === task.status)) {
    blockTask(ctx, tx, task, reason);
  }
  openAttention(ctx, tx, {
    task_id: task.id,
    kind: 'question',
    question: `${task.title}（${task.id}）的 worktree ${err.worktreePath} 沒有通過身分檢查：${err.reason}。服務端已拒絕在其中執行任何 git 指令，沒有提交任何東西。這通常表示 worktree 的 .git 被改寫（可能指向主 repo，提交會落在基底分支）。請檢查並修復（例如在主 repo 執行不帶路徑的 git worktree repair——不要帶這個 worktree 的路徑，那會跟隨被改寫的指標、改壞別的 worktree），再由人重試；或取消任務。`,
    options: [],
  });
}
