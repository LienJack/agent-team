import type { StateSnapshot } from '@agent-team/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useClient } from '../api/context.js';
import { errorLine } from '../api/errors.js';
import { keys } from '../api/keys.js';
import { buildTaskRequest, type NewTaskErrors, type NewTaskInput } from '../lib/new-task.js';
import { STATUS_LABELS } from '../lib/format.js';
import { useUi } from '../store/ui.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';
import { Empty } from './ui/states.js';

const TIERS = [
  { value: 'A', hint: '跨模組或公開介面' },
  { value: 'B', hint: '多檔案、需要判斷' },
  { value: 'C', hint: '介面已定、有測試' },
] as const;

const INPUT =
  'w-full rounded-md border border-line bg-bg px-2 text-sm aria-[invalid=true]:border-bad';

function FieldBlock({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** New task (spec §11 POST /tasks): project, title, tier, owned paths, ticket, queue now. */
export function NewTaskForm({ state }: { state: StateSnapshot }) {
  const client = useClient();
  const qc = useQueryClient();
  const close = () => useUi.getState().setNewTaskOpen(false);
  const toast = useUi((s) => s.toast);
  const openTask = useUi((s) => s.openTask);
  const projectFilter = useUi((s) => s.projectFilter);
  const ids = { project: useId(), title: useId(), paths: useId(), ticket: useId(), queue: useId() };
  const [input, setInput] = useState<NewTaskInput>({
    project_id: projectFilter ?? (state.projects.length === 1 ? state.projects[0]!.id : ''),
    title: '',
    tier: 'C',
    owned_paths: '',
    ticket_md: '',
    queue: true,
  });
  const [errors, setErrors] = useState<NewTaskErrors>({});
  const create = useMutation({
    mutationFn: (body: Parameters<typeof client.createTask>[0]) => client.createTask(body),
    onSuccess: async (task) => {
      toast('ok', `已建立「${task.title}」（${STATUS_LABELS[task.status]}）`);
      await qc.invalidateQueries({ queryKey: keys.state() });
      close();
      openTask(task.id);
    },
  });
  const set = <K extends keyof NewTaskInput>(key: K, value: NewTaskInput[K]) =>
    setInput((prev) => ({ ...prev, [key]: value }));
  const invalid = (key: keyof NewTaskInput) => (errors[key] ? true : undefined);
  const describedBy = (key: keyof NewTaskInput, id: string) =>
    errors[key] ? `${id}-error` : undefined;

  const submit = () => {
    const result = buildTaskRequest(input);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate(result.body);
  };

  const formId = useId();
  return (
    <Dialog
      title="新增任務"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            pending={create.isPending}
            disabled={state.projects.length === 0}
          >
            {input.queue ? '建立並排入佇列' : '建立草稿'}
          </Button>
        </>
      }
    >
      {state.projects.length === 0 ? (
        <Empty>
          還沒有專案。專案只能在本機新增（例如 <code>team project add</code>），區網無法新增。
        </Empty>
      ) : (
        <form
          id={formId}
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) submit();
          }}
        >
          <FieldBlock id={ids.project} label="專案" error={errors.project_id}>
            <select
              id={ids.project}
              value={input.project_id}
              onChange={(e) => set('project_id', e.target.value)}
              aria-invalid={invalid('project_id')}
              aria-describedby={describedBy('project_id', ids.project)}
              className={`${INPUT} h-9`}
              data-autofocus
            >
              <option value="">請選擇…</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FieldBlock>
          <FieldBlock id={ids.title} label="標題" error={errors.title}>
            <input
              id={ids.title}
              value={input.title}
              maxLength={200}
              onChange={(e) => set('title', e.target.value)}
              aria-invalid={invalid('title')}
              aria-describedby={describedBy('title', ids.title)}
              className={`${INPUT} h-9`}
            />
          </FieldBlock>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Tier</legend>
            <div className="grid grid-cols-3 gap-2">
              {TIERS.map((t) => (
                <label
                  key={t.value}
                  className={`flex cursor-pointer flex-col rounded-md border p-2 text-xs ${input.tier === t.value ? 'border-accent bg-info-soft' : 'border-line'}`}
                >
                  <span className="flex items-center gap-1 text-sm font-medium">
                    <input
                      type="radio"
                      name="tier"
                      value={t.value}
                      checked={input.tier === t.value}
                      onChange={() => set('tier', t.value)}
                    />
                    {t.value}
                  </span>
                  <span className="text-muted">{t.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <FieldBlock
            id={ids.paths}
            label="owned_paths"
            error={errors.owned_paths}
            hint="每行一個 repo 相對路徑或 glob（例如 src/feature/、docs/*.md）"
          >
            <textarea
              id={ids.paths}
              rows={3}
              value={input.owned_paths}
              onChange={(e) => set('owned_paths', e.target.value)}
              aria-invalid={invalid('owned_paths')}
              aria-describedby={describedBy('owned_paths', ids.paths)}
              className={`${INPUT} py-1.5 font-mono`}
            />
          </FieldBlock>
          <FieldBlock id={ids.ticket} label="派工單（Markdown）" error={errors.ticket_md}>
            <textarea
              id={ids.ticket}
              rows={8}
              value={input.ticket_md}
              onChange={(e) => set('ticket_md', e.target.value)}
              aria-invalid={invalid('ticket_md')}
              aria-describedby={describedBy('ticket_md', ids.ticket)}
              className={`${INPUT} py-1.5`}
            />
          </FieldBlock>
          <label htmlFor={ids.queue} className="flex items-center gap-2 text-sm">
            <input
              id={ids.queue}
              type="checkbox"
              checked={input.queue}
              onChange={(e) => set('queue', e.target.checked)}
            />
            立即排入佇列（不勾選則建立為草稿）
          </label>
          {create.isError ? (
            <p role="alert" className="rounded-md bg-bad-soft p-2 text-sm text-bad break-words">
              {errorLine(create.error)}
            </p>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}
