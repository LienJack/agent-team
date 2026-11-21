import type { Message } from '@agent-team/client';

// Chat with the leader: server history merged with messages this page is still sending.
// `client_msg_id` is the dedupe key end to end (spec §5, §9): the server stores a message once
// per id, a retry reuses the id, and a pending entry disappears once history contains it.

export type PendingState = 'sending' | 'stored' | 'failed';

export interface PendingMessage {
  client_msg_id: string;
  text: string;
  created_at: string;
  state: PendingState;
  /** Leader reply that was not stored as a message (`reply_message_id: null`). */
  reply?: string;
  /** Inline notice for this message (e.g. leader not available yet). */
  notice?: string;
  /** Why sending failed (connection, validation…). */
  error?: string;
}

export interface ChatItem {
  key: string;
  direction: 'in' | 'out';
  body: string;
  source: Message['source'];
  at: string;
  state: 'sent' | 'sending' | 'failed';
  notice?: string;
  error?: string;
  /** Present on this page's own messages (retry uses it). */
  clientMsgId?: string;
  /** An input the leader has not answered yet (stored, queued or in its turn). */
  awaiting?: boolean;
}

/** History in seq order, then pending messages the server has not returned yet. */
export function mergeChat(
  history: readonly Message[],
  pending: readonly PendingMessage[],
): ChatItem[] {
  const byClientId = new Map(pending.map((p) => [p.client_msg_id, p]));
  const seen = new Set<string>();
  const items: ChatItem[] = [];
  const sorted = [...history].sort((a, b) => a.seq - b.seq);
  for (const message of sorted) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const mine = message.direction === 'in' ? byClientId.get(message.client_msg_id) : undefined;
    items.push({
      key: message.id,
      direction: message.direction,
      body: message.body,
      source: message.source,
      at: message.created_at,
      state: 'sent',
      ...(mine?.notice ? { notice: mine.notice } : {}),
      ...(mine ? { clientMsgId: mine.client_msg_id } : {}),
      ...(message.direction === 'in' && message.status === 'new' ? { awaiting: true } : {}),
    });
    if (mine?.reply !== undefined) items.push(replyItem(mine));
    if (mine) byClientId.delete(message.client_msg_id);
  }
  const rest = [...byClientId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const p of rest) {
    items.push({
      key: `pending:${p.client_msg_id}`,
      direction: 'in',
      body: p.text,
      source: 'web',
      at: p.created_at,
      state: p.state === 'failed' ? 'failed' : p.state === 'sending' ? 'sending' : 'sent',
      clientMsgId: p.client_msg_id,
      ...(p.notice ? { notice: p.notice } : {}),
      ...(p.error ? { error: p.error } : {}),
    });
    if (p.reply !== undefined) items.push(replyItem(p));
  }
  return items;
}

function replyItem(p: PendingMessage): ChatItem {
  return {
    key: `reply:${p.client_msg_id}`,
    direction: 'out',
    body: p.reply ?? '',
    source: 'service',
    at: p.created_at,
    state: 'sent',
  };
}

/** Insert or replace the pending entry with the same client_msg_id. */
export function upsertPending(
  list: readonly PendingMessage[],
  next: PendingMessage,
): PendingMessage[] {
  const i = list.findIndex((p) => p.client_msg_id === next.client_msg_id);
  if (i < 0) return [...list, next];
  const copy = [...list];
  copy[i] = next;
  return copy;
}

/** Append pages fetched with `after` without duplicating rows (seq is unique). */
export function appendPage(history: readonly Message[], page: readonly Message[]): Message[] {
  const known = new Set(history.map((m) => m.seq));
  return [...history, ...page.filter((m) => !known.has(m.seq))];
}
