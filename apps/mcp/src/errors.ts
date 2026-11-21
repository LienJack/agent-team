import { TeamApiError } from '@agent-team/client';

export const NOT_RUNNING_MESSAGE =
  'agent-team is not running (or unreachable). Ask the user to run `team serve`, then retry.';

/** One-line tool error text: `code: message (hint)`; service-down gets a plain instruction. */
export function describeError(err: unknown): string {
  if (err instanceof TeamApiError) {
    if (err.status === 0) return NOT_RUNNING_MESSAGE;
    return err.hint === undefined
      ? `${err.code}: ${err.message}`
      : `${err.code}: ${err.message} (${err.hint})`;
  }
  return `internal: ${err instanceof Error ? err.message : String(err)}`;
}
