import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// One board smoke test (`pnpm --filter @agent-team/web test:e2e`). The browser is the installed
// Google Chrome (`channel: 'chrome'`) so no Playwright browser download is needed; set
// PW_CHANNEL=chromium to use a Playwright-managed Chromium instead. Artefacts go to the OS temp dir.
export default defineConfig({
  testDir: 'e2e',
  outputDir: join(tmpdir(), 'agent-team-web-playwright'),
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  use: {
    channel: process.env['PW_CHANNEL'] ?? 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
