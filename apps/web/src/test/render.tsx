import type { TeamClient } from '@agent-team/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { ClientProvider } from '../api/context.js';

// Test-only: render with a fake client and a fresh QueryClient (no retries, no caching).

export function fakeClient(methods: Partial<TeamClient>): TeamClient {
  const missing = (name: string) => () => {
    throw new Error(`fake client: ${name} not stubbed`);
  };
  return new Proxy(methods, {
    get: (target, prop: string) =>
      prop in target ? target[prop as keyof TeamClient] : missing(prop),
  }) as TeamClient;
}

export function renderWithClient(
  ui: ReactElement,
  client: TeamClient,
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  // a wrapper (not a wrapped element) so `rerender` keeps the providers
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ClientProvider>
  );
  const result = render(ui, { wrapper });
  return { ...result, queryClient };
}
