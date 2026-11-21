import { ErrorEnvelopeSchema, type ErrorCode } from '@agent-team/schema';

/** Plain shape of an API error (spec §11 envelope), as printed by `--json`. */
export interface TeamErrorInfo {
  code: ErrorCode;
  message: string;
  hint?: string;
}

/**
 * Every failure of the client: an error envelope from the server, or a connection problem
 * (`unavailable`, HTTP status 0). `exitCodeFor(err.code)` gives the CLI exit code.
 */
export class TeamApiError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  /** HTTP status; 0 when no response was received. */
  readonly status: number;

  constructor(info: TeamErrorInfo, status: number) {
    super(info.message);
    this.name = 'TeamApiError';
    this.code = info.code;
    this.hint = info.hint;
    this.status = status;
  }

  toJSON(): TeamErrorInfo {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint };
  }
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'locked',
  503: 'unavailable',
};

/** Turn a non-2xx response body into a `TeamApiError` (envelope if present, else by status). */
export function errorFromResponse(status: number, body: unknown): TeamApiError {
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, hint } = parsed.data.error;
    return new TeamApiError(
      hint === undefined ? { code, message } : { code, message, hint },
      status,
    );
  }
  return new TeamApiError(
    { code: STATUS_CODES[status] ?? 'internal', message: `HTTP ${status}` },
    status,
  );
}

/** A request that never got a response (connection refused, reset, DNS, …). */
export function connectionError(baseUrl: string, cause: unknown): TeamApiError {
  const detail = cause instanceof Error ? (cause.cause ?? cause).toString() : String(cause);
  return new TeamApiError(
    {
      code: 'unavailable',
      message: `cannot reach agent-team at ${baseUrl} (${detail})`,
      hint: 'start the service with `team serve`',
    },
    0,
  );
}
