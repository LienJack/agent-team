import { TeamError, type Engine, type Store, type Tx } from '@agent-team/core';
import type { Message, MessageChannel, MessageSource } from '@agent-team/schema';

// Leader messages in the database (spec §9 回覆持久化): every reply is an outgoing message that
// refers to its input (`ref`), keyed `reply:<input id>` so a duplicate input finds it, and a
// `leader.reply` event; the input is marked `delivered` in the same transaction.

export const replyKey = (inboundId: string) => `reply:${inboundId}`;

export function findReply(store: Pick<Store, 'messages'>, inbound: Message): Message | undefined {
  return store.messages.findByClientMsgId(inbound.channel, replyKey(inbound.id));
}

/**
 * The stored reply of `inbound` (as the API returns it), undefined while none exists, or a
 * conflict for a duplicate input that was handled without one (and is not queued any more).
 */
export function storedAnswer(
  store: Pick<Store, 'messages'>,
  inbound: Message,
  info: { duplicate: boolean; inflight: boolean },
): { reply: string; reply_message_id: string } | undefined {
  const stored = findReply(store, inbound);
  if (stored) return { reply: stored.body, reply_message_id: stored.id };
  if (!info.inflight && info.duplicate && inbound.status !== 'new') {
    throw new TeamError(
      'conflict',
      `message ${inbound.id} was already handled without a reply`,
      'send it again with a new client_msg_id',
    );
  }
  return undefined;
}

/** Stored human inputs that never got an answer (restart, rate limit): queued again. */
export function unansweredMessages(store: Pick<Store, 'messages'>): Message[] {
  return store.messages
    .list()
    .filter(
      (m) =>
        m.direction === 'in' &&
        m.status === 'new' &&
        m.source !== 'service' &&
        findReply(store, m) === undefined,
    );
}

export function insertMessage(
  engine: Engine,
  tx: Tx,
  fields: {
    channel: MessageChannel;
    direction: 'in' | 'out';
    source: MessageSource;
    body: string;
    client_msg_id: string;
    ref: string | null;
    status: Message['status'];
  },
): Message {
  const message = tx.r.messages.insert({
    id: engine.ctx.newId('message'),
    ...fields,
    created_at: tx.now,
  });
  tx.emit('message.created', {
    message_id: message.id,
    channel: message.channel,
    direction: message.direction,
    source: message.source,
  });
  return message;
}

export function markDelivered(tx: Tx, id: string): void {
  const current = tx.r.messages.get(id);
  if (!current || current.status !== 'new') return;
  tx.r.messages.update({ ...current, status: 'delivered' });
  tx.emit('message.status_changed', { message_id: id, status: 'delivered' });
}

export type ReplyInput =
  | { kind: 'message'; inbound: Message }
  /** An engine-event digest: stored as an incoming `service` message together with the reply. */
  | { kind: 'digest'; body: string; key: string };

/** Store the reply (and a digest input) in one transaction; `extra` runs in it too. */
export function persistReply(
  engine: Engine,
  input: ReplyInput,
  text: string,
  extra: (tx: Tx, inbound: Message, reply: Message) => void,
): { inbound: Message; reply: Message } {
  return engine.ctx.transact((tx) => {
    let inbound: Message;
    if (input.kind === 'message') {
      inbound = tx.r.messages.get(input.inbound.id) ?? input.inbound;
    } else {
      inbound =
        tx.r.messages.findByClientMsgId('leader', input.key) ??
        insertMessage(engine, tx, {
          channel: 'leader',
          direction: 'in',
          source: 'service',
          body: input.body,
          client_msg_id: input.key,
          ref: null,
          status: 'new',
        });
    }
    const existing = tx.r.messages.findByClientMsgId(inbound.channel, replyKey(inbound.id));
    if (existing) return { inbound, reply: existing };
    const reply = insertMessage(engine, tx, {
      channel: inbound.channel,
      direction: 'out',
      source: 'service',
      body: text,
      client_msg_id: replyKey(inbound.id),
      ref: inbound.id,
      status: 'new',
    });
    markDelivered(tx, inbound.id);
    tx.emit('leader.reply', {
      message_id: reply.id,
      in_reply_to: inbound.id,
      channel: inbound.channel,
    });
    extra(tx, inbound, reply);
    return { inbound, reply };
  });
}
