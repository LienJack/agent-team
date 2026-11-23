import { errorMessage, TeamError, type Logger } from '@agent-team/core';
import { ERROR_HTTP_STATUS, errorEnvelope, type ErrorCode } from '@agent-team/schema';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodError } from 'zod';

// Every error leaves the API as `{ error: { code, message, hint? } }` (spec §11).

const HTTP_CODES: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'bad_request',
  415: 'bad_request',
  429: 'too_many_requests',
  503: 'unavailable',
};

export function sendError(c: Context, code: ErrorCode, message: string, hint?: string): Response {
  return c.json(
    errorEnvelope(code, message, hint),
    ERROR_HTTP_STATUS[code] as ContentfulStatusCode,
  );
}

/** Convert anything thrown by a handler or middleware into the envelope. */
export function onError(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof TeamError) return sendError(c, err.code, err.message, err.hint);
    if (err instanceof HTTPException) {
      const code = HTTP_CODES[err.status] ?? (err.status >= 500 ? 'internal' : 'bad_request');
      return sendError(c, code, err.message || `HTTP ${err.status}`);
    }
    logger.error('request failed', {
      method: c.req.method,
      path: c.req.path,
      error: errorMessage(err),
    });
    return sendError(c, 'internal', 'internal error');
  };
}

export const notFound: NotFoundHandler = (c) =>
  sendError(c, 'not_found', `no route for ${c.req.method} ${c.req.path}`);

/** First issue of a ZodError as `path: message`. */
export function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid request';
  const path = issue.path.map(String).join('.');
  return `${path || 'request'}: ${issue.message}`;
}

/** zod-openapi validation hook: request validation failures → 400 `validation_failed`. */
export function validationHook(
  result: { success: true; data: unknown } | { success: false; error: ZodError; target: string },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  return sendError(c, 'validation_failed', `${result.target}: ${zodMessage(result.error)}`);
}
