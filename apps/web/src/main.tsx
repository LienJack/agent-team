import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserClient } from './api/client.js';
import { ClientProvider } from './api/context.js';
import { createQueryClient } from './api/query-client.js';
import { App } from './components/app.js';
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet (Tailwind entry)
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const client = createBrowserClient(window.location.origin);
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <ClientProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ClientProvider>
  </StrictMode>,
);
