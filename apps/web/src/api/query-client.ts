import { TeamApiError } from '@agent-team/client';
import { QueryClient } from '@tanstack/react-query';

const NO_RETRY = new Set(['unauthorized', 'forbidden', 'not_found']);

/** Retry reads only for transient failures (connection, 503), never for auth or 4xx answers. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof TeamApiError && (NO_RETRY.has(error.code) || error.status === 400)) {
    return false;
  }
  return failureCount < 3;
}

/** The page's QueryClient (the LAN listener has no login, docs/adr/0024). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });
}
