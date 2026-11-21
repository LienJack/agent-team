import type { Task } from '@agent-team/client';
import { boardColumnOf, type BoardColumnId, type TaskStatus } from '@agent-team/schema';

// Which task actions are legal, mirroring the engine's commands (packages/core
// engine/commands.ts). The server stays the authority: these rules only decide which buttons are
// enabled and which drops are attempted; every outcome comes from the API response.

export type TaskActionKind = 'queue' | 'retry' | 'approve' | 'reject' | 'cancel' | 'reassign';

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);

/** Why an action is unavailable for `task`, or undefined when it may be tried. */
export function actionBlocker(
  task: Pick<Task, 'status' | 'current_run_id'>,
  action: TaskActionKind,
): string | undefined {
  const { status } = task;
  switch (action) {
    case 'queue':
      return status === 'draft' ? undefined : '只有草稿可以排入佇列';
    case 'retry':
      return status === 'blocked' || status === 'failed'
        ? undefined
        : '只有阻塞或失敗的任務可以重試';
    case 'approve':
    case 'reject':
      return status === 'review' ? undefined : '只有待驗收的任務可以通過或退回';
    case 'cancel':
      return TERMINAL.has(status) ? '任務已結束' : undefined;
    case 'reassign':
      if (TERMINAL.has(status)) return '任務已結束';
      if (task.current_run_id !== null || status === 'verifying') {
        return '有執行中的 run，請先停止或等待結束';
      }
      return undefined;
  }
}

export type DropAction = 'queue' | 'retry' | 'approve' | 'reject';

export type DropDecision =
  /** Dropped where it already is (or nowhere): nothing to do. */
  | { kind: 'none' }
  /** Try this action; `confirm` = ask first (approve/reject). */
  | { kind: 'action'; action: DropAction; confirm: boolean }
  /** Not a legal move: the card snaps back and `reason` is shown. */
  | { kind: 'refused'; reason: string };

const REFUSE = (reason: string): DropDecision => ({ kind: 'refused', reason });

/**
 * What dropping a card of `status` on column `target` means. Draft and queued share 待派, so
 * "queue" is dragging a draft into 進行中; review → 完成 approves, review → 待派/進行中 rejects
 * (both confirmed); blocked/failed → 待派/進行中 retries. Everything else is refused.
 */
export function decideDrop(status: TaskStatus, target: BoardColumnId | undefined): DropDecision {
  if (target === undefined || boardColumnOf(status) === target) return { kind: 'none' };
  if (target === 'blocked') return REFUSE('阻塞由服務端判定，不能手動移入');
  switch (status) {
    case 'draft':
      return target === 'in_progress'
        ? { kind: 'action', action: 'queue', confirm: false }
        : REFUSE('草稿要拖到「進行中」才會排入佇列');
    case 'queued':
      return REFUSE('已在佇列中，等待排程器派工');
    case 'running':
    case 'verifying':
      return REFUSE('執行中的任務由服務端推進；要停止請開啟卡片按「停止」');
    case 'review':
      return target === 'done'
        ? { kind: 'action', action: 'approve', confirm: true }
        : { kind: 'action', action: 'reject', confirm: true };
    case 'blocked':
    case 'failed':
      return target === 'done'
        ? REFUSE('只有待驗收的任務可以標記完成')
        : { kind: 'action', action: 'retry', confirm: false };
    case 'done':
      return REFUSE('已完成的任務不能再移動');
    case 'cancelled':
      return REFUSE('已取消的任務不能移動');
  }
}

export const ACTION_LABELS: Record<TaskActionKind, string> = {
  queue: '排入佇列',
  retry: '重試',
  approve: '通過',
  reject: '退回',
  cancel: '停止並取消',
  reassign: '改派',
};

/** Roles offered by the reassign picker (no API lists config/models.json roles yet). */
export const REASSIGN_ROLES = ['impl_A', 'impl_B', 'impl_C'] as const;
