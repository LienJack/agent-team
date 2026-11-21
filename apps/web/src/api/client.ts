import { createTeamClient, type TeamClient } from '@agent-team/client';
import { randomId } from './ids.js';

/**
 * The board's API client: same origin as the page (the LAN listener serves both), the session
 * cookie travels with `same-origin`, and Idempotency-Keys come from `randomId` because the
 * client's default (`crypto.randomUUID`) is missing on plain-HTTP LAN origins.
 */
export function createBrowserClient(
  origin: string,
  fetchImpl?: (request: Request) => Promise<Response>,
): TeamClient {
  return createTeamClient({
    baseUrl: origin,
    credentials: 'same-origin',
    newKey: () => randomId(),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
