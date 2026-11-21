import type { Task } from '@agent-team/client';
import { RoleNameSchema } from '@agent-team/schema';
import { useId, useState } from 'react';
import { useTaskAction } from '../../api/mutations.js';
import {
  ACTION_LABELS,
  actionBlocker,
  REASSIGN_ROLES,
  type TaskActionKind,
} from '../../lib/actions.js';
import { ConfirmAction, type ConfirmableAction } from '../confirm-action.js';
import { Button } from '../ui/button.js';

const OTHER = '__other__';

function ReassignForm({ task, blocker }: { task: Task; blocker: string | undefined }) {
  const mutation = useTaskAction();
  const selectId = useId();
  const otherId = useId();
  const [choice, setChoice] = useState<string>(
    (REASSIGN_ROLES as readonly string[]).includes(task.impl_role) ? task.impl_role : OTHER,
  );
  const [other, setOther] = useState(choice === OTHER ? task.impl_role : '');
  const role = choice === OTHER ? other.trim() : choice;
  const valid = RoleNameSchema.safeParse(role).success;
  const unchanged = role === task.impl_role;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !unchanged && !blocker)
          mutation.mutate({ id: task.id, action: 'reassign', role });
      }}
    >
      <div className="space-y-0.5">
        <label htmlFor={selectId} className="block text-xs text-muted">
          改派角色（目前 {task.impl_role}）
        </label>
        <select
          id={selectId}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={blocker !== undefined}
          className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
        >
          {REASSIGN_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
          <option value={OTHER}>其他角色…</option>
        </select>
      </div>
      {choice === OTHER ? (
        <div className="space-y-0.5">
          <label htmlFor={otherId} className="block text-xs text-muted">
            角色名稱
          </label>
          <input
            id={otherId}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="例如 impl_B"
            aria-invalid={(other !== '' && !valid) || undefined}
            disabled={blocker !== undefined}
            className="h-9 w-36 rounded-md border border-line bg-bg px-2 font-mono text-sm"
          />
        </div>
      ) : null}
      <Button
        type="submit"
        pending={mutation.isPending}
        disabled={blocker !== undefined || !valid || unchanged}
        title={blocker ?? (unchanged ? '已是這個角色' : undefined)}
      >
        {ACTION_LABELS.reassign}
      </Button>
    </form>
  );
}

/** Drawer actions; each is enabled by the same rules as the drag targets. */
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
      <ReassignForm task={task} blocker={actionBlocker(task, 'reassign')} />
      {confirm ? (
        <ConfirmAction task={task} action={confirm} onClose={() => setConfirm(null)} />
      ) : null}
    </div>
  );
}
