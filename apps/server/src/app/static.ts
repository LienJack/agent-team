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
  input, button { font: inherit; padding: .4rem .6rem; }
</style>
</head>
<body>
<h1>agent-team</h1>
<p>看板尚未建置（<code>apps/web</code>）。API 已可使用：登入後可讀取 <code>/api/state</code>。</p>
<form id="login">
  <label>區網密碼 <input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">登入</button>
</form>
<p id="result" role="status"></p>
<script>
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get('password');
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await res.json().catch(() => ({}));
    document.getElementById('result').textContent = res.ok
      ? '已登入。'
      : (body.error && body.error.message) || '登入失敗';
  });
</script>
</body>
</html>
`;

/**
 * Board files for the LAN listener: `apps/web/dist` when it has an `index.html` (unknown paths
 * fall back to it for client-side routing), else the placeholder page. Never under /api or /auth.
 */
export function registerStatic(app: OpenAPIHono<AppEnv>, webDist: string | undefined): void {
  if (webDist === undefined) {
    app.get('/', (c) => c.html(PLACEHOLDER_HTML));
    return;
  }
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/')) return next();
    return serveStatic<AppEnv>({ root: webDist })(c, next);
  });
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/')) return next();
    return c.html(await readFile(`${webDist}/index.html`, 'utf8'));
  });
}
