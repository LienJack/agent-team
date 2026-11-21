import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

// One board smoke test (`pnpm test:e2e` at the root, or `pnpm --filter @agent-team/web test:e2e`).
// Browser: Playwright's bundled Chromium when it is installed (CI runs `playwright install
// chromium`), otherwise the system Google Chrome (`channel: 'chrome'`), so no download is needed
// on a machine that has Chrome. PW_CHANNEL forces a channel (e.g. `chrome`, `msedge`).
// Artefacts go to the OS temp dir.

function bundledChromium(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const forced = process.env['PW_CHANNEL'];
const channel = forced ?? (bundledChromium() ? undefined : 'chrome');

export default defineConfig({
  testDir: 'e2e',
  outputDir: join(tmpdir(), 'agent-team-web-playwright'),
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  use: {
    ...(channel === undefined ? {} : { channel }),
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
