import type { Task, TeamClient } from '@agent-team/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ACTION_LABELS, type TaskActionKind } from '../lib/actions.js';
import type { NewTaskRequest } from '../lib/new-task.js';
import { STATUS_LABELS } from '../lib/format.js';
import { useUi } from '../store/ui.js';
import { useClient } from './context.js';
import { errorLine } from './errors.js';
import { keys } from './keys.js';

export type TaskActionRequest =
  | { id: string; action: 'queue' | 'retry' | 'approve' }
  | { id: string; action: 'cancel'; reason?: string }
  | { id: string; action: 'reject'; note: string }
  | { id: string; action: 'reassign'; role: string };

/** One task command through the client (which adds the Idempotency-Key). */
export function runTaskAction(client: TeamClient, req: TaskActionRequest): Promise<Task> {
  switch (req.action) {
    case 'reject':
      return client.rejectTask(req.id, req.note);
    case 'reassign':
      return client.reassignTask(req.id, req.role);
    case 'cancel':
      return client.taskAction(req.id, 'cancel', req.reason);
    default:
      return client.taskAction(req.id, req.action);
  }
}

/**
 * Task actions for buttons and drops. Nothing is changed locally: success toasts the status the
 * server answered, failure toasts the server's reason, and both refetch the board and the task.
 */
export function useTaskAction() {
  const client = useClient();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: (req: TaskActionRequest) => runTaskAction(client, req),
    onSuccess: (task, req) => {
      toast(
        'ok',
        `${ACTION_LABELS[req.action as TaskActionKind]}：任務現在是「${STATUS_LABELS[task.status]}」`,
      );
    },
    onError: (err, req) => {
      toast('bad', `${ACTION_LABELS[req.action as TaskActionKind]}失敗 — ${errorLine(err)}`);
    },
    onSettled: (_task, _err, req) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.state() }),
        qc.invalidateQueries({ queryKey: keys.task(req.id) }),
      ]),
  });
}

/** Delete one item of a project's memory (spec §18); the list refetches either way. */
export function useRemoveMemory() {
  const client = useClient();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: (req: { projectId: string; memoryId: string }) =>
      client.removeMemory(req.projectId, req.memoryId),
    onSuccess: () => toast('ok', '已刪除這筆專案記憶'),
    onSettled: (_r, _e, req) => qc.invalidateQueries({ queryKey: keys.memory(req.projectId) }),
  });
}

/** POST /tasks or POST /research (spec §17), by the kind picked in the dialog. */
export function createNewTask(client: TeamClient, req: NewTaskRequest): Promise<Task> {
  return req.kind === 'research' ? client.createResearch(req.body) : client.createTask(req.body);
}

/**
 * The new-task dialog's create call: success toasts what the server created and refetches the
 * board; failure is left to the dialog (it stays open and shows the server's reason).
 */
export function useCreateTask() {
  const client = useClient();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: (req: NewTaskRequest) => createNewTask(client, req),
    onSuccess: async (task, req) => {
      const what = req.kind === 'research' ? '調研' : '';
      toast('ok', `已建立${what}「${task.title}」（${STATUS_LABELS[task.status]}）`);
      await qc.invalidateQueries({ queryKey: keys.state() });
    },
  });
}
