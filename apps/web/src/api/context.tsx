import type { TeamClient } from '@agent-team/client';
import { createContext, useContext, type ReactNode } from 'react';

const ClientContext = createContext<TeamClient | null>(null);

/** Provides the API client (tests inject a fake one). */
export function ClientProvider({ client, children }: { client: TeamClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): TeamClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useClient outside <ClientProvider>');
  return client;
}
