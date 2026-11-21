import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Smoke tests against the REAL CLIs (claude, codex, dsh). Never part of `pnpm test`:
// run with `TEAM_SMOKE=1 pnpm --filter @agent-team/runners test:smoke`.
const conditions = ['@agent-team/source', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['test/smoke/**/*.smoke.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
