import { createTeamClient, type TeamClient } from '@agent-team/client';

/**
 * The board's API client: same origin as the page (the LAN listener serves both) and the session
 * cookie travels with `same-origin`. Idempotency-Keys use the client's default (`randomId`, from
 * `crypto.getRandomValues`), which also works on plain-HTTP LAN origins.
 */
export function createBrowserClient(
  origin: string,
  fetchImpl?: (request: Request) => Promise<Response>,
): TeamClient {
  return createTeamClient({
    baseUrl: origin,
    credentials: 'same-origin',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
