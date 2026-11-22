import { ValidationError, withIdempotency, type Clock, type Store } from '@agent-team/core';
import { IDEMPOTENCY_HEADER, type JsonValue } from '@agent-team/schema';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './types.js';

/** Response header set when a stored response is replayed. */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

class NotStored extends Error {}

/**
 * `Idempotency-Key` on mutating /api requests (spec §5), backed by core's `withIdempotency` and
 * the store's idempotency repository: same key + same payload → the stored response (handler not
 * run again); same key + different payload → 409 `idempotency_conflict`. Business errors (4xx)
 * are stored like successes; 5xx responses are not, so the client may retry with the same key.
 * `refresh` may rewrite a replayed success (state that changes over time, e.g. a delivery).
 */
export function idempotency(deps: {
  store: Store;
  clock: Clock;
  /** Rewrites a replayed body (task commands recompute their delivery; docs/adr/0022). */
  refresh?: (body: JsonValue) => JsonValue;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (c.req.method !== 'POST' || key === undefined) {
      await next();
      return;
    }
    if (key.length === 0 || key.length > 200) {
      throw new ValidationError(`${IDEMPOTENCY_HEADER} must be 1–200 characters`);
    }
    const text = await c.req.text();
    let payload: unknown = text;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON: hash the raw text (the route will reject it anyway)
    }
    let outcome;
    try {
      outcome = await withIdempotency(
        deps.store,
        deps.clock,
        { caller: c.get('caller'), requestId: key, method: `POST ${c.req.path}`, payload },
        async () => {
          await next();
          if (c.res.status >= 500) throw new NotStored();
          const body = (await c.res
            .clone()
            .json()
            .catch(() => null)) as JsonValue;
          return { status: c.res.status, body };
        },
      );
    } catch (err) {
      if (err instanceof NotStored) return; // c.res already holds the error response
      throw err;
    }
    if (outcome.replayed) {
      const { status, body } = outcome.response;
      const replayed = deps.refresh && status < 300 ? deps.refresh(body) : body;
      return new Response(JSON.stringify(replayed), {
        status,
        headers: { 'content-type': 'application/json', [REPLAYED_HEADER]: 'true' },
      });
    }
    return undefined;
  };
}
