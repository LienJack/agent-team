import type { IdempotentResponse, JsonValue } from '@agent-team/schema';
import { IdempotencyConflictError, RequestInProgressError } from './errors.js';
import type { Store } from './ports/repositories.js';
import type { Clock } from './ports/services.js';
import { canonicalJson, sha256Hex } from './util/hash.js';

export interface IdempotentRequest {
  /** Who is calling (token / session / source), so keys of different callers never collide. */
  caller: string;
  /** The `Idempotency-Key` header value. */
  requestId: string;
  /** e.g. `POST /api/tasks/:id/queue` (route template + concrete path is fine). */
  method: string;
  /** Request body/params that define "the same request". */
  payload: unknown;
}

export interface IdempotentOutcome {
  response: IdempotentResponse;
  /** True when the stored response of an earlier identical request was returned. */
  replayed: boolean;
}

/** sha256 of the canonical JSON of `method` + `payload`. */
export function payloadHash(method: string, payload: unknown): string {
  return sha256Hex(canonicalJson({ method, payload: payload ?? null }));
}

/**
 * Run a mutating request at most once per (caller, requestId) (spec §5):
 * - same key + same payload → the stored response (`replayed: true`), handler not called;
 * - same key + different payload/method → `IdempotencyConflictError` (409);
 * - same key while the first request is still running → `RequestInProgressError` (409).
 * The handler's response (success or handled business error) is stored. If the handler throws,
 * the pending record is removed so the client may retry with the same key.
 */
export async function withIdempotency(
  store: Store,
  clock: Clock,
  request: IdempotentRequest,
  handler: () => Promise<IdempotentResponse>,
): Promise<IdempotentOutcome> {
  const hash = payloadHash(request.method, request.payload);
  const existing = store.atomic((tx) => {
    const found = tx.idempotency.get(request.caller, request.requestId);
    if (found) return found;
    tx.idempotency.insert({
      caller: request.caller,
      request_id: request.requestId,
      method: request.method,
      payload_hash: hash,
      state: 'pending',
      response: null,
      created_at: clock.now().toISOString(),
    });
    return undefined;
  });
  if (existing) {
    if (existing.payload_hash !== hash || existing.method !== request.method) {
      throw new IdempotencyConflictError(request.requestId);
    }
    if (existing.state === 'pending' || existing.response === null) {
      throw new RequestInProgressError(request.requestId);
    }
    return { response: existing.response, replayed: true };
  }

  let response: IdempotentResponse;
  try {
    response = await handler();
  } catch (err) {
    store.atomic((tx) => tx.idempotency.delete(request.caller, request.requestId));
    throw err;
  }
  const stored: IdempotentResponse = {
    status: response.status,
    body: JSON.parse(JSON.stringify(response.body ?? null)) as JsonValue,
  };
  store.atomic((tx) => {
    const rec = tx.idempotency.get(request.caller, request.requestId);
    if (rec) tx.idempotency.update({ ...rec, state: 'completed', response: stored });
  });
  return { response: stored, replayed: false };
}
