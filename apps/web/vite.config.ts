import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The board is served by the server's LAN listener from apps/web/dist (spec §11, §13).
// Workspace packages are bundled from source through their `@agent-team/source` export condition,
// so a build does not depend on the other packages' dist/.
//
// `pnpm dev` proxies /api to a running LAN listener (AGENT_TEAM_WEB_PROXY, default
// http://127.0.0.1:4518).
const proxyTarget = process.env['AGENT_TEAM_WEB_PROXY'] ?? 'http://127.0.0.1:4518';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@agent-team/source', ...defaultClientConditions] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // long-lived vendor chunks (cache across board updates) keep each file under the 500 kB hint
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor', test: /node_modules/ },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: proxyTarget },
    },
  },
});
