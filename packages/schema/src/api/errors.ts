import { z } from 'zod';

/** Machine-readable error codes used by the API, CLI exit codes and engine errors. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'lan_forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'invalid_transition',
  'idempotency_conflict',
  'request_in_progress',
  'locked',
  'unavailable',
  /** The endpoint exists but its feature is not built yet (e.g. the phase 2 leader stub). */
  'not_implemented',
  'internal',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** HTTP status for each error code. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  lan_forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  invalid_transition: 409,
  idempotency_conflict: 409,
  request_in_progress: 409,
  locked: 429,
  unavailable: 503,
  not_implemented: 501,
  internal: 500,
};

/** Every API error body (spec §11): `{ error: { code, message, hint? } }`. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    hint: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function errorEnvelope(code: ErrorCode, message: string, hint?: string): ErrorEnvelope {
  return { error: hint === undefined ? { code, message } : { code, message, hint } };
}

/** CLI exit codes (spec §12). */
export const EXIT_CODES = { ok: 0, business: 1, usage: 2 } as const;

/** Business errors exit 1; auth/connection/usage problems exit 2. */
export function exitCodeFor(code: ErrorCode): number {
  return code === 'unauthorized' || code === 'unavailable' || code === 'bad_request'
    ? EXIT_CODES.usage
    : EXIT_CODES.business;
}

/** Header carrying the idempotency key on mutating requests (spec §5). */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
