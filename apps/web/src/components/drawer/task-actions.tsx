import type { Task } from '@agent-team/client';
import { useId, useRef, useState } from 'react';
import { useTaskAction } from '../../api/mutations.js';
import { useRoles } from '../../api/queries.js';
import {
  ACTION_LABELS,
  actionBlocker,
  reassignChoices,
  type TaskActionKind,
} from '../../lib/actions.js';
import { ConfirmAction, type ConfirmableAction } from '../confirm-action.js';
import { Button } from '../ui/button.js';

/** Reassign picker: the roles of config/models.json (GET /api/roles), enabled ones only. */
function ReassignForm({ task, blocker }: { task: Task; blocker: string | undefined }) {
  const mutation = useTaskAction();
  const roles = useRoles();
  const selectId = useId();
  const [role, setRole] = useState<string>(task.impl_role);
  const { impl, other } = reassignChoices(roles.data, task.impl_role);
  const unchanged = role === task.impl_role;
  // set synchronously: `isPending` only shows up after the next render
  const inFlight = useRef(false);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        // one request at a time: a second submit (double click, Enter) while the first is in
        // flight is ignored, not sent again
        if (unchanged || blocker || mutation.isPending || inFlight.current) return;
        inFlight.current = true;
        mutation.mutate(
          { id: task.id, action: 'reassign', role },
          { onSettled: () => void (inFlight.current = false) },
        );
      }}
    >
      <div className="space-y-0.5">
        <label htmlFor={selectId} className="block text-xs text-muted">
          改派角色（目前 {task.impl_role}）
        </label>
        <select
          id={selectId}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={blocker !== undefined}
          className="h-9 max-w-full rounded-md border border-line bg-surface px-2 text-sm"
        >
          <optgroup label="實作角色">
            {impl.map((r) => (
              <option key={r.name} value={r.name}>
                {r.label}
              </option>
            ))}
          </optgroup>
          {other.length > 0 ? (
            <optgroup label="其他角色">
              {other.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {roles.isError ? (
          <p className="text-xs text-warn">讀不到角色清單，只列出預設的實作角色。</p>
        ) : null}
      </div>
      <Button
        type="submit"
        pending={mutation.isPending}
        disabled={blocker !== undefined || unchanged || mutation.isPending}
        title={blocker ?? (unchanged ? '已是這個角色' : undefined)}
      >
        {ACTION_LABELS.reassign}
      </Button>
    </form>
  );
}

/**
 * Drawer actions; each is enabled by the same rules as the drag targets. A research task gets
 * queue / retry / cancel only (no review, fixed role).
 */
export function TaskActions({ task }: { task: Task }) {
  const mutation = useTaskAction();
  const [confirm, setConfirm] = useState<ConfirmableAction | null>(null);
  const pendingAction = mutation.isPending ? mutation.variables?.action : undefined;

  const direct = (action: 'queue' | 'retry') => {
    const blocker = actionBlocker(task, action);
    return (
      <Button
        key={action}
        variant="primary"
        disabled={blocker !== undefined || mutation.isPending}
        pending={pendingAction === action}
        title={blocker}
        onClick={() => mutation.mutate({ id: task.id, action })}
      >
        {ACTION_LABELS[action]}
      </Button>
    );
  };
  const confirmed = (action: ConfirmableAction, variant: 'primary' | 'secondary' | 'danger') => {
    const blocker = actionBlocker(task, action as TaskActionKind);
    return (
      <Button
        key={action}
        variant={variant}
        disabled={blocker !== undefined}
        title={blocker}
        onClick={() => setConfirm(action)}
      >
        {ACTION_LABELS[action]}
      </Button>
    );
  };
  const visible = (action: TaskActionKind) => actionBlocker(task, action) === undefined;
  if (!visible('cancel')) {
    return (
      <p className="text-muted">
        任務已{task.status === 'done' ? '完成' : '取消'}，沒有可用的操作。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {visible('queue') ? direct('queue') : null}
        {visible('retry') ? direct('retry') : null}
        {visible('approve') ? confirmed('approve', 'primary') : null}
        {visible('reject') ? confirmed('reject', 'secondary') : null}
        {confirmed('cancel', 'danger')}
      </div>
      {task.kind === 'research' ? null : (
        <ReassignForm task={task} blocker={actionBlocker(task, 'reassign')} />
      )}
      {confirm ? (
        <ConfirmAction task={task} action={confirm} onClose={() => setConfirm(null)} />
      ) : null}
    </div>
  );
}
