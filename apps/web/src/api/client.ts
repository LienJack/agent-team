import { createTeamClient, type TeamClient } from '@agent-team/client';

/**
 * The board's API client: same origin as the page (the LAN listener serves both; it takes no
 * credential, docs/adr/0024). Idempotency-Keys use the client's default (`randomId`, from
 * `crypto.getRandomValues`), which also works on plain-HTTP LAN origins.
 */
export function createBrowserClient(
  origin: string,
  fetchImpl?: (request: Request) => Promise<Response>,
): TeamClient {
  return createTeamClient({ baseUrl: origin, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
