import { randomId, type LeaderStatusView, type StateSnapshot } from '@agent-team/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react';
import { useClient } from '../api/context.js';
import { errorLine, isLeaderUnavailable } from '../api/errors.js';
import { keys } from '../api/keys.js';
import { useLeaderMessages } from '../api/queries.js';
import { mergeChat, type ChatItem, type PendingMessage } from '../lib/chat.js';
import { formatTime } from '../lib/format.js';
import { useChat } from '../store/chat.js';
import { Button } from './ui/button.js';
import { Empty, ErrorState, Loading } from './ui/states.js';

export const LEADER_UNAVAILABLE_NOTICE = 'Leader 暫時無法回覆：訊息已保存，恢復後會依序回覆。';

/** Inline notice for a message stored while the leader cannot take turns. */
export function leaderNotice(leader: LeaderStatusView): string | undefined {
  if (leader.available !== false || leader.reason === null || leader.reason === undefined) {
    return undefined;
  }
  if (leader.reason === 'disabled') {
    return 'Leader 沒有啟用（service.json 的 leader.enabled）：訊息已保存，但不會有回覆。';
  }
  return `${LEADER_UNAVAILABLE_NOTICE}${leader.hint ? `（${leader.hint}）` : ''}`;
}

const TEXT_MAX = 20000;

/**
 * Send one message (new or retried with the same client_msg_id; the server dedupes). Non-blocking
 * (`wait: false`): the POST returns once the message is stored and queued; the reply arrives as a
 * `leader.reply` event, which refetches the history.
 */
export function useSendLeaderMessage() {
  const client = useClient();
  const qc = useQueryClient();
  const upsert = useChat((s) => s.upsert);
  return useMutation({
    mutationFn: (p: PendingMessage) =>
      client.sendLeaderMessage({
        text: p.text,
        source: 'web',
        client_msg_id: p.client_msg_id,
        wait: false,
      }),
    onMutate: (p) => upsert({ ...p, state: 'sending' }),
    onSuccess: (res, p) => {
      const notice = res.pending ? leaderNotice(res.leader) : undefined;
      const next: PendingMessage = {
        client_msg_id: p.client_msg_id,
        text: p.text,
        created_at: p.created_at,
        state: 'stored',
        ...(notice ? { notice } : {}),
      };
      // a reply that was not stored as a message would be lost on refetch: keep it here
      upsert(
        res.reply !== null && res.reply_message_id === null ? { ...next, reply: res.reply } : next,
      );
    },
    onError: (err, p) => {
      const base = { client_msg_id: p.client_msg_id, text: p.text, created_at: p.created_at };
      upsert(
        isLeaderUnavailable(err)
          ? { ...base, state: 'stored', notice: LEADER_UNAVAILABLE_NOTICE }
          : { ...base, state: 'failed', error: errorLine(err) },
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.leaderMessages() }),
  });
}

/** Who wrote a chat item: the person, the leader, or the service's event digest for the leader. */
export function speakerOf(item: Pick<ChatItem, 'direction' | 'source'>): {
  kind: 'mine' | 'leader' | 'service';
  label: string;
} {
  if (item.direction === 'out') return { kind: 'leader', label: 'Leader' };
  // inputs the service generated (engine-event digests) were not written by the person
  if (item.source === 'service') return { kind: 'service', label: '服務端事件摘要（交給 leader）' };
  return { kind: 'mine', label: `我（${item.source}）` };
}

const BUBBLE_STYLE = {
  mine: 'border-accent/30 bg-info-soft',
  leader: 'border-line bg-surface',
  service: 'border-dashed border-line bg-raised text-xs text-muted',
} as const;

function Bubble({ item, onRetry }: { item: ChatItem; onRetry: (id: string) => void }) {
  const speaker = speakerOf(item);
  const mine = speaker.kind === 'mine';
  return (
    <li
      className={`flex flex-col gap-1 ${mine ? 'items-end' : speaker.kind === 'service' ? 'items-center' : 'items-start'}`}
    >
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 break-words whitespace-pre-wrap ${BUBBLE_STYLE[speaker.kind]}`}
      >
        <span className="sr-only">{`${speaker.label}：`}</span>
        {item.body}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span>{speaker.label}</span>
        <span>{formatTime(item.at)}</span>
        {item.state === 'sending' ? <span role="status">傳送中…</span> : null}
        {item.awaiting && item.state === 'sent' ? (
          <span role="status">等待 leader 回覆…</span>
        ) : null}
        {item.state === 'failed' ? <span className="text-bad">未送出</span> : null}
      </div>
      {item.notice ? (
        <p
          role="status"
          className="max-w-[85%] rounded-md bg-warn-soft px-2 py-1 text-xs text-warn"
        >
          <span aria-hidden="true">ℹ </span>
          {item.notice}
        </p>
      ) : null}
      {item.state === 'failed' && item.clientMsgId ? (
        <div className="flex max-w-[85%] flex-wrap items-center gap-2 text-xs text-bad">
          <span className="break-words">{item.error}</span>
          <Button size="sm" onClick={() => onRetry(item.clientMsgId!)}>
            重送
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Chat with the leader (spec §13 聊天面板). */
export function ChatPanel({ state }: { state: StateSnapshot | undefined }) {
  const history = useLeaderMessages();
  const pending = useChat((s) => s.pending);
  const draft = useChat((s) => s.draft);
  const setDraft = useChat((s) => s.setDraft);
  const send = useSendLeaderMessage();
  const inputId = useId();
  const list = useRef<HTMLOListElement>(null);
  const items = useMemo(() => mergeChat(history.data ?? [], pending), [history.data, pending]);
  const sending = pending.some((p) => p.state === 'sending');

  useEffect(() => {
    const node = list.current;
    if (node && typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight });
  }, [items.length]);

  const submit = () => {
    const text = draft.trim();
    if (text === '' || text.length > TEXT_MAX) return;
    setDraft('');
    send.mutate({
      client_msg_id: randomId(),
      text,
      created_at: new Date().toISOString(),
      state: 'sending',
    });
  };
  const retry = (clientMsgId: string) => {
    const p = pending.find((m) => m.client_msg_id === clientMsgId);
    if (p) send.mutate(p);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full min-h-80 flex-col gap-2">
      {state?.leader.state === 'offline' ? (
        <p className="rounded-md border border-line bg-raised px-2 py-1 text-xs text-muted">
          Leader 目前離線：訊息會保存，但不會有即時回覆。
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {history.isPending ? <Loading label="讀取對話…" /> : null}
        {history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : null}
        {!history.isPending && items.length === 0 ? <Empty>還沒有對話。</Empty> : null}
        {items.length > 0 ? (
          <ol
            ref={list}
            aria-label="對話紀錄"
            className="max-h-[60vh] space-y-3 overflow-y-auto pr-1"
          >
            {items.map((item) => (
              <Bubble key={item.key} item={item} onRetry={retry} />
            ))}
          </ol>
        ) : null}
      </div>
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          給 leader 的訊息
        </label>
        <textarea
          id={inputId}
          rows={3}
          value={draft}
          maxLength={TEXT_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="給 leader 的訊息（⌘/Ctrl + Enter 送出）"
          className="w-full rounded-md border border-line bg-bg p-2 text-sm"
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" pending={sending} disabled={draft.trim() === ''}>
            送出
          </Button>
        </div>
      </form>
    </div>
  );
}
