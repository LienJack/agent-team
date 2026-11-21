import {
  enqueueEffect,
  outboxLane,
  type Engine,
  type KvRepository,
  type Tx,
} from '@agent-team/core';
import type { NotifyKind, OutboxItem } from '@agent-team/schema';

// Hub-written outbox rows (spec §10 出：一律先寫 outbox 再發送): the same shape and guarantees as
// the engine's own notifications — row + `outbox.queued` event + `outbox.send` effect in the
// caller's transaction, nothing when the signature exists (also after a restart). Grok replies
// carry their routing in kv (`hub:outbox:<id>`), written in the same transaction.

export interface ReplyMeta {
  /** The grokmsg id being answered. */
  reply_to: string;
  /** working = receipt ack (not pushed); final = the leader's answer; ack = choice recorded. */
  mode: 'working' | 'final' | 'ack';
}

export const metaKey = (outboxId: string) => `hub:outbox:${outboxId}`;
export const summaryKey = (outboxId: string) => `hub:summary:${outboxId}`;
/** grokmsg id (a message we replied to with options, or a notice) → attention id. */
export const anchorKey = (grokId: string) => `hub:anchor:${grokId}`;

export function readMeta(kv: KvRepository, outboxId: string): ReplyMeta | undefined {
  const raw = kv.get(metaKey(outboxId));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as ReplyMeta;
  } catch {
    return undefined;
  }
}

export interface OutboxInput {
  kind: NotifyKind;
  signature: string;
  body: string;
  task_id: string | null;
  meta?: ReplyMeta;
}

/** Queue one outbox item in `tx`; undefined when notifications are off or the signature exists. */
export function enqueueOutbox(engine: Engine, tx: Tx, input: OutboxInput): OutboxItem | undefined {
  if (!engine.ctx.config.notifications) return undefined;
  if (tx.r.outbox.findBySignature(input.signature)) return undefined;
  const item: OutboxItem = {
    id: engine.ctx.newId('outbox'),
    target: 'grok',
    kind: input.kind,
    body: input.body,
    signature: input.signature,
    status: 'pending',
    task_id: input.task_id,
    attempts: 0,
    error: null,
    created_at: tx.now,
    sent_at: null,
  };
  tx.r.outbox.insert(item);
  if (input.meta) tx.r.kv.set(metaKey(item.id), JSON.stringify(input.meta));
  tx.emit(
    'outbox.queued',
    { outbox_id: item.id, kind: item.kind, signature: item.signature },
    { task_id: item.task_id },
  );
  // replies to one Grok message keep their order (working → final) in their own lane; a
  // notice stuck in backoff never holds them up
  enqueueEffect(tx, 'outbox.send', item.id, {
    outbox_id: item.id,
    task_id: item.task_id,
    lane: outboxLane(item, input.meta?.reply_to),
  });
  return item;
}
