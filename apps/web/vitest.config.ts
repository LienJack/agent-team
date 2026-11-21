import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Scoped web tests (`pnpm --filter @agent-team/web test`): logic tests (`*.test.ts`) also run
// under the root config in node; component tests (`*.test.tsx`) need jsdom and run here only.
const sourceCondition = '@agent-team/source';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: [sourceCondition, 'module', 'browser', 'default'] },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: ['src/test/setup.ts'],
  },
});
