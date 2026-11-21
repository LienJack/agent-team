import type { NotifyKind, OutboxItem } from '@agent-team/schema';
import type { EngineContext, Tx } from './context.js';
import { enqueueEffect } from './effect-queue.js';

export interface NotificationInput {
  kind: NotifyKind;
  /** Dedupe key: the same signature is never queued twice, also across restarts (spec §10). */
  signature: string;
  body: string;
  task_id: string | null;
}

/**
 * Queue a proactive notification: outbox row + `outbox.send` effect in the current transaction.
 * No-op when notifications are disabled (`grok.enabled = false`) or the signature exists.
 */
export function notify(
  ctx: EngineContext,
  tx: Tx,
  input: NotificationInput,
): OutboxItem | undefined {
  if (!ctx.config.notifications) return undefined;
  if (tx.r.outbox.findBySignature(input.signature)) return undefined;
  const item: OutboxItem = {
    id: ctx.newId('outbox'),
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
  tx.emit(
    'outbox.queued',
    { outbox_id: item.id, kind: item.kind, signature: item.signature },
    { task_id: item.task_id },
  );
  enqueueEffect(tx, 'outbox.send', item.id, { outbox_id: item.id, task_id: item.task_id });
  return item;
}
