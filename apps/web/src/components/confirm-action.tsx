import type { Task } from '@agent-team/client';
import { useId, useState } from 'react';
import { errorLine } from '../api/errors.js';
import { useTaskAction } from '../api/mutations.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';

export type ConfirmableAction = 'approve' | 'reject' | 'cancel';

const COPY: Record<ConfirmableAction, { title: string; body: string; confirm: string }> = {
  approve: {
    title: '通過驗收？',
    body: '任務會標為完成；尚在進行的模型審查會被停止。',
    confirm: '通過',
  },
  reject: {
    title: '退回修正？',
    body: '退回說明會成為下一輪修正的必改清單，任務會重新排入佇列。',
    confirm: '退回',
  },
  cancel: {
    title: '停止並取消任務？',
    body: '執行中的 run 會被終止，任務改為「已取消」且不能恢復。',
    confirm: '停止並取消',
  },
};

const NOTE_MAX = 4000;

/** Confirmation for approve / reject (note required) / cancel; stays open on failure. */
export function ConfirmAction({
  task,
  action,
  onClose,
}: {
  task: Pick<Task, 'id' | 'title'>;
  action: ConfirmableAction;
  onClose: () => void;
}) {
  const mutation = useTaskAction();
  const [note, setNote] = useState('');
  const noteId = useId();
  const copy = COPY[action];
  const noteOk = action !== 'reject' || (note.trim() !== '' && note.length <= NOTE_MAX);

  const submit = () => {
    if (!noteOk || mutation.isPending) return;
    const req =
      action === 'reject'
        ? { id: task.id, action, note: note.trim() }
        : action === 'cancel'
          ? { id: task.id, action, reason: '從看板停止' }
          : { id: task.id, action };
    mutation.mutate(req, { onSuccess: onClose });
  };

  return (
    <Dialog
      title={copy.title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>返回</Button>
          <Button
            variant={action === 'approve' ? 'primary' : 'danger'}
            pending={mutation.isPending}
            disabled={!noteOk}
            onClick={submit}
            data-autofocus={action === 'reject' ? undefined : true}
          >
            {copy.confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="break-words font-medium" title={task.title}>
          {task.title}
        </p>
        <p className="text-muted">{copy.body}</p>
        {action === 'reject' ? (
          <div className="space-y-1">
            <label htmlFor={noteId} className="block text-sm font-medium">
              退回說明（必填）
            </label>
            <textarea
              id={noteId}
              data-autofocus
              value={note}
              maxLength={NOTE_MAX}
              rows={5}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-md border border-line bg-bg p-2 text-sm"
            />
            <p className="text-right text-xs text-muted">
              {note.length} / {NOTE_MAX}
            </p>
          </div>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="rounded-md bg-bad-soft p-2 text-sm text-bad break-words">
            {errorLine(mutation.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
