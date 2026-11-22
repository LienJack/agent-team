import type { EffectKind, EffectPayload, EffectRecord, JsonValue } from '@agent-team/schema';
import type { EngineContext, Tx } from './context.js';

/** What an effect handler returns: applied in the same transaction that deletes the effect. */
export type EffectFinalizer = (tx: Tx) => void;

/**
 * Executes one effect kind. Do the IO, then return a finalizer for the state changes; throw to
 * retry with backoff. `onDead` runs (in a transaction) when retries are exhausted.
 */
export interface EffectHandler {
  run(ctx: EngineContext, effect: EffectRecord): Promise<EffectFinalizer | undefined>;
  onDead?(ctx: EngineContext, tx: Tx, effect: EffectRecord, error: string): void;
}

/**
 * Store-first: write the effect in the same transaction as the state change that requires it
 * (spec §1.3). The executor runs it after commit; a crash before completion leaves the row, so it
 * runs again after restart. Enqueueing an existing (kind, key) bumps its generation.
 */
export function enqueueEffect<K extends EffectKind>(
  tx: Tx,
  kind: K,
  key: string,
  payload: EffectPayload<K>,
  due: string = tx.now,
): EffectRecord {
  tx.dirty = true;
  return tx.r.effects.upsert({ kind, key, payload: payload as unknown as JsonValue, due });
}

/** Payload typed by kind (validated when it was enqueued). */
export function effectPayload<K extends EffectKind>(
  effect: EffectRecord,
  _kind: K,
): EffectPayload<K> {
  return effect.payload as unknown as EffectPayload<K>;
}

/** Effects in the same lane run one at a time in seq order; different lanes run concurrently. */
export function effectLane(effect: EffectRecord): string {
  if (effect.kind === 'outbox.send') {
    const payload = effect.payload as { task_id?: string | null; lane?: string } | null;
    if (typeof payload?.lane === 'string') return `outbox:${payload.lane}`;
    return `outbox:${payload?.task_id ?? '-'}`; // effects stored before lanes existed
  }
  // project memory writes (spec §18) go one at a time, in the order they were stored
  if (effect.kind === 'memory.write') return 'memory';
  return `${effect.kind}:${effect.key}`;
}
