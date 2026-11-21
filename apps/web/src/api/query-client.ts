import { TeamApiError } from '@agent-team/client';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { useUi } from '../store/ui.js';
import { isUnauthorized } from './errors.js';

const NO_RETRY = new Set(['unauthorized', 'forbidden', 'lan_forbidden', 'not_found', 'locked']);

/** Retry reads only for transient failures (connection, 503), never for auth or 4xx answers. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof TeamApiError && (NO_RETRY.has(error.code) || error.status === 400)) {
    return false;
  }
  return failureCount < 3;
}

/**
 * The page's QueryClient. Any 401 (expired session, server restart: the session key is random
 * per start) switches the page to the login screen.
 */
export function createQueryClient(): QueryClient {
  const onError = (error: unknown) => {
    if (isUnauthorized(error)) useUi.getState().setAuth('required');
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });
}
