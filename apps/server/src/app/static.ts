import { readFile } from 'node:fs/promises';
import { serveStatic } from '@hono/node-server/serve-static';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './types.js';

/** Shown on the LAN listener until `apps/web` is built (phase 4). */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-team</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
</style>
</head>
<body>
<h1>agent-team</h1>
<p>看板尚未建置（<code>pnpm build</code>）。API 已可使用，例如 <a href="/api/state"><code>/api/state</code></a>。</p>
</body>
</html>
`;

/**
 * Board files for the LAN listener: `apps/web/dist` when it has an `index.html` (unknown paths
 * fall back to it for client-side routing), else the placeholder page. Never under /api.
 */
export function registerStatic(app: OpenAPIHono<AppEnv>, webDist: string | undefined): void {
  if (webDist === undefined) {
    app.get('/', (c) => c.html(PLACEHOLDER_HTML));
    return;
  }
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    return serveStatic<AppEnv>({ root: webDist })(c, next);
  });
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    return c.html(await readFile(`${webDist}/index.html`, 'utf8'));
  });
}
