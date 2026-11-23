import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { z } from 'zod';
import { ERROR_RESPONSE } from './constants.js';

// Building blocks shared by every route contract (spec §11). The server implements the routes;
// the client's types are generated from the document these produce.

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 500 | 501 | 503;

const ERROR_REF = { $ref: `#/components/responses/${ERROR_RESPONSE}` } as const;

/**
 * Error responses of a route: always 400 (validation), 401 (local listener token), 403 (leader
 * guard) and 500, plus the route-specific ones. All share the error envelope component.
 */
export function errors(...extra: ErrorStatus[]): Record<string, typeof ERROR_REF> {
  const codes = new Set<ErrorStatus>([400, 401, 403, ...extra, 500]);
  return Object.fromEntries([...codes].sort((a, b) => a - b).map((code) => [code, ERROR_REF]));
}

/** A JSON response with `schema`. */
export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } } as const;
}

/** A required JSON request body. */
export function body<T extends z.ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } } as const;
}

/** An optional JSON request body (actions whose only field is optional). */
export function optionalBody<T extends z.ZodType>(schema: T) {
  return { required: false, content: { 'application/json': { schema } } } as const;
}

/**
 * Headers of a mutating route (spec §5): the optional `Idempotency-Key`. Same key + same payload
 * replays the stored response; same key + different payload is 409 `idempotency_conflict`.
 */
export const MutationHeadersSchema = z.object({
  [IDEMPOTENCY_HEADER]: z.string().min(1).max(200).optional(),
});

/** `{ id }` path parameter for `pattern` (one of the id schemas). */
export function idParam<T extends z.ZodType<string>>(schema: T) {
  return z.object({ id: schema });
}
