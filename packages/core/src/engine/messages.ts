import type { Message, MessageChannel, MessageSource, MessageStatus } from '@agent-team/schema';
import { NotFoundError } from '../errors.js';
import type { EngineContext } from './context.js';

export interface RecordMessageInput {
  channel: MessageChannel;
  direction: 'in' | 'out';
  source: MessageSource;
  body: string;
  /** Dedupe key per channel (client message id, grokmsg id); generated when omitted. */
  client_msg_id?: string;
  ref?: string | null;
}

/**
 * Store a chat message, deduplicated by (channel, client_msg_id) (spec §9, §10). Returns the
 * existing message with `duplicate: true` when the key was seen before.
 */
export function recordMessage(
  ctx: EngineContext,
  input: RecordMessageInput,
): { message: Message; duplicate: boolean } {
  return ctx.transact((tx) => {
    const id = ctx.newId('message');
    const clientMsgId = input.client_msg_id ?? id;
    const existing = tx.r.messages.findByClientMsgId(input.channel, clientMsgId);
    if (existing) return { message: existing, duplicate: true };
    const message = tx.r.messages.insert({
      id,
      channel: input.channel,
      direction: input.direction,
      source: input.source,
      body: input.body,
      client_msg_id: clientMsgId,
      ref: input.ref ?? null,
      status: 'new',
      created_at: tx.now,
    });
    tx.emit('message.created', {
      message_id: message.id,
      channel: message.channel,
      direction: message.direction,
      source: message.source,
    });
    return { message, duplicate: false };
  });
}

export function setMessageStatus(ctx: EngineContext, id: string, status: MessageStatus): Message {
  return ctx.transact((tx) => {
    const message = tx.r.messages.get(id);
    if (!message) throw new NotFoundError('message', id);
    if (message.status === status) return message;
    const next = { ...message, status };
    tx.r.messages.update(next);
    tx.emit('message.status_changed', { message_id: id, status });
    return next;
  });
}
