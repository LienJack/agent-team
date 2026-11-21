import type { Attention, StateSnapshot } from '@agent-team/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useClient } from '../api/context.js';
import { errorLine } from '../api/errors.js';
import { keys } from '../api/keys.js';
import { formatTime } from '../lib/format.js';
import { useUi } from '../store/ui.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Empty } from './ui/states.js';

const KIND_LABELS: Record<Attention['kind'], string> = {
  decision: '決策',
  approval: '核准',
  question: '問題',
};

/** POST /api/attention/:id/answer with `via: "web"`; the item leaves once the board refetches. */
export function useAnswerAttention() {
  const client = useClient();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: string }) =>
      client.answerAttention(id, { answer, via: 'web' }),
    onSuccess: async (item) => {
      toast('ok', `已回答：${item.answer ?? ''}`);
      await qc.invalidateQueries({ queryKey: keys.state() });
      if (item.task_id) await qc.invalidateQueries({ queryKey: keys.task(item.task_id) });
    },
  });
}

function AttentionItem({ item, taskTitle }: { item: Attention; taskTitle: string | undefined }) {
  const answer = useAnswerAttention();
  const openTask = useUi((s) => s.openTask);
  const [text, setText] = useState('');
  const textId = useId();
  const questionId = useId();
  const busy = answer.isPending;
  const chosen = busy ? answer.variables?.answer : undefined;

  return (
    <li
      aria-labelledby={questionId}
      className="space-y-2 rounded-md border border-warn/40 bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone="warn">
          <span aria-hidden="true">◆</span>
          {KIND_LABELS[item.kind]}
        </Badge>
        <span className="text-muted">{formatTime(item.created_at)}</span>
        {item.task_id ? (
          <button
            type="button"
            onClick={() => openTask(item.task_id!)}
            className="min-w-0 truncate text-accent underline-offset-2 hover:underline"
            title={taskTitle ?? item.task_id}
          >
            任務：{taskTitle ?? item.task_id}
          </button>
        ) : null}
      </div>
      <p id={questionId} className="font-medium break-words whitespace-pre-wrap">
        {item.question}
      </p>
      {item.options.length > 0 ? (
        <div role="group" aria-label="選項" className="flex flex-wrap gap-2">
          {item.options.map((option) => (
            <Button
              key={option}
              onClick={() => answer.mutate({ id: item.id, answer: option })}
              disabled={busy}
              pending={chosen === option}
              className="h-auto min-h-9 max-w-full py-1 text-left break-words whitespace-normal"
            >
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== '') answer.mutate({ id: item.id, answer: text.trim() });
          }}
        >
          <label htmlFor={textId} className="sr-only">
            回答
          </label>
          <textarea
            id={textId}
            rows={2}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            placeholder="輸入回答"
            className="min-w-0 flex-1 rounded-md border border-line bg-bg p-2 text-sm"
          />
          <Button type="submit" variant="primary" pending={busy} disabled={text.trim() === ''}>
            送出
          </Button>
        </form>
      )}
      {answer.isError ? (
        <p role="alert" className="text-xs text-bad break-words">
          {errorLine(answer.error)}
        </p>
      ) : null}
    </li>
  );
}

/** Open attention items (spec §13 待決事項): the question plus one button per option. */
export function AttentionPanel({ state }: { state: StateSnapshot }) {
  const items = [...state.open_attention].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const titles = new Map(state.tasks.map((t) => [t.id, t.title]));
  if (items.length === 0) return <Empty>目前沒有待決事項</Empty>;
  return (
    <ul className="space-y-2" aria-label="待決事項">
      {items.map((item) => (
        <AttentionItem
          key={item.id}
          item={item}
          taskTitle={item.task_id ? titles.get(item.task_id) : undefined}
        />
      ))}
    </ul>
  );
}
