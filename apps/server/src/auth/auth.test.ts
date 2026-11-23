import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  lanRequest,
  TEST_LEADER_TOKEN,
  TEST_TOKEN,
  type Loose,
  type TestService,
} from '../testing/harness.js';
import { constantTimeEqual } from './secrets.js';

let h: TestService;

beforeEach(() => {
  h = createTestService();
});
afterEach(async () => {
  await h.cleanup();
});

const errorCode = async (res: Response) => ((await res.json()) as Loose).error.code as string;

describe('§14 server — local listener bearer auth', () => {
  it('requires the listener token', async () => {
    const app = h.localApp();
    expect((await app.request('/api/state')).status).toBe(401);
    const wrong = await app.request('/api/state', { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(await errorCode(wrong)).toBe('unauthorized');
    const ok = await app.request('/api/state', {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('has no login route and no board files', async () => {
    const app = h.localApp();
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(404);
    expect((await app.request('/')).status).toBe(404);
  });

  it('the leader-scoped token makes leader actions; a header cannot', async () => {
    const app = h.localApp();
    const res = await app.request('/api/attention', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_LEADER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ question: 'Q?' }),
    });
    expect(res.status).toBe(201);
    // project registration is the owner's call (leader-guard.test.ts)
    const project = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_LEADER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'demo', repo_path: '/repos/demo' }),
    });
    expect(project.status).toBe(403);
  });
});

describe('§14 server — LAN listener without login (docs/adr/0024)', () => {
  it('opens the API without any credential; the old login route is gone', async () => {
    const app = h.lanApp();
    expect((await lanRequest(app, '/api/state')).status).toBe(200);
    expect((await lanRequest(app, '/api/doctor')).status).toBe(200);
    const login = await lanRequest(app, '/auth/login', { body: { password: 'x' } });
    expect(login.status).toBe(404);
    expect(login.headers.get('set-cookie')).toBeNull();
  });

  it('checks no Origin, Sec-Fetch-Site or Host (the owner’s decision)', async () => {
    const app = h.lanApp();
    const foreign = {
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
      host: 'evil.example:4518',
    };
    expect((await lanRequest(app, '/api/state', { headers: foreign })).status).toBe(200);
    const write = await lanRequest(app, '/api/attention', {
      body: { question: 'Q?' },
      headers: foreign,
    });
    expect(write.status).toBe(201);
    expect((await lanRequest(app, '/', { headers: foreign })).status).toBe(200);
  });

  it('acts as the human: registers projects and resets the leader like the operator', async () => {
    const app = h.lanApp();
    const project = await lanRequest(app, '/api/projects', {
      body: { name: 'demo', repo_path: '/repos/demo' },
    });
    expect(project.status).toBe(201);
    expect(h.store.projects.list().map((p) => p.name)).toEqual(['demo']);
    const reset = await lanRequest(app, '/api/leader/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    // human-only decisions are open too
    const q = h.service.engine.openAttention({ question: 'Q?', options: ['A'] });
    const answer = await lanRequest(app, `/api/attention/${q.id}/answer`, {
      body: { answer: 'A' },
    });
    expect(answer.status).toBe(200);
    expect(h.store.attention.get(q.id)?.answered_via).toBe('web');
  });

  it('serves the placeholder board page', async () => {
    const res = await lanRequest(h.lanApp(), '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('agent-team');
    expect(html).not.toMatch(/password|密碼/i);
  });

  it('serves a built board: assets and the index fallback for client routes', async () => {
    const web = mkdtempSync(join(tmpdir(), 'team-web-'));
    try {
      writeFileSync(join(web, 'index.html'), '<!doctype html><title>board</title>');
      mkdirSync(join(web, 'assets'));
      writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
      const built = createTestService({ webDist: web });
      try {
        const app = built.lanApp();
        const asset = await lanRequest(app, '/assets/app.js');
        expect(asset.status).toBe(200);
        expect(await asset.text()).toBe('console.log(1)');
        expect(asset.headers.get('cache-control')).toContain('immutable');
        const index = await lanRequest(app, '/');
        expect(index.status).toBe(200);
        expect(index.headers.get('cache-control')).toBe('no-cache');
        const route = await lanRequest(app, '/tasks/t_000001');
        expect(route.status).toBe(200);
        expect(route.headers.get('cache-control')).toBe('no-cache');
        expect(await route.text()).toContain('<title>board</title>');
        // an old page asking for a hash a rebuild deleted gets a 404, not index.html
        const stale = await lanRequest(app, '/assets/index-old.js');
        expect(stale.status).toBe(404);
        expect(stale.headers.get('content-type') ?? '').not.toContain('text/html');
        expect((await lanRequest(app, '/api/state')).status).toBe(200);
        expect((await lanRequest(app, '/api/nope')).status).toBe(404);
        // the login endpoint is gone here too (no handler answers a POST to it)
        const login = await lanRequest(app, '/auth/login', { body: { password: 'x' } });
        expect(login.status).toBe(404);
      } finally {
        await built.cleanup();
      }
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});

describe('secrets helpers', () => {
  it('constantTimeEqual compares strings of any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});
