import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Leader smoke against the REAL claude CLI (spends a little subscription quota). Never part of
// `pnpm test`: run with `pnpm --filter @agent-team/server test:smoke` (sets TEAM_SMOKE=1) after
// `pnpm build` (the leader's `team` is the built CLI).
const conditions = ['@agent-team/source', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['test/smoke/**/*.smoke.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
