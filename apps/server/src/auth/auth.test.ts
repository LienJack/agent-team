import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME } from '@agent-team/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  SOURCE_HEADER,
  TEST_PASSWORD,
  TEST_TOKEN,
  type Loose,
  type TestService,
} from '../testing/harness.js';
import { Lockout } from './lockout.js';
import { constantTimeEqual } from './secrets.js';
import { SessionSigner } from './session.js';

let h: TestService;

beforeEach(() => {
  h = createTestService();
});
afterEach(async () => {
  await h.cleanup();
});

const HOST = '192.168.1.20:4518';
const ORIGIN = `http://${HOST}`;

function lanRequest(
  app: ReturnType<TestService['lanApp']>,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return app.request(`http://${HOST}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      host: HOST,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function login(
  app: ReturnType<TestService['lanApp']>,
  password = TEST_PASSWORD,
  source = 'a',
) {
  return lanRequest(app, '/auth/login', {
    body: { password },
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', [SOURCE_HEADER]: source },
  });
}

function cookieOf(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  return header.split(';')[0]!;
}

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
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(res.status).toBe(404);
    expect((await app.request('/')).status).toBe(404);
  });

  it('marks calls with X-Team-Actor: leader as leader actions', async () => {
    const app = h.localApp();
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
        'x-team-actor': 'leader',
      },
      body: JSON.stringify({ name: 'demo', repo_path: '/repos/demo' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('§14 server — LAN login and session cookie', () => {
  it('login sets an HttpOnly, SameSite=Strict cookie that opens the API', async () => {
    const app = h.lanApp();
    expect((await lanRequest(app, '/api/state')).status).toBe(401);
    const res = await login(app);
    expect(res.status).toBe(200);
    const header = res.headers.get('set-cookie')!;
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).not.toContain(TEST_PASSWORD);
    const state = await lanRequest(app, '/api/state', { headers: { cookie: cookieOf(res) } });
    expect(state.status).toBe(200);
  });

  it('a wrong password is 401; a tampered or expired cookie is rejected', async () => {
    const app = h.lanApp();
    expect(await errorCode(await login(app, 'wrong'))).toBe('unauthorized');
    const cookie = cookieOf(await login(app));
    const tampered = `${cookie.slice(0, -2)}xx`;
    expect((await lanRequest(app, '/api/state', { headers: { cookie: tampered } })).status).toBe(
      401,
    );
    h.clock.advance(h.config.lan.session_hours * 3_600_000 + 1);
    expect((await lanRequest(app, '/api/state', { headers: { cookie } })).status).toBe(401);
  });

  it('sessions from another process start (another key) are invalid', async () => {
    const cookie = cookieOf(await login(h.lanApp()));
    const other = h.lanApp();
    expect((await lanRequest(other, '/api/state', { headers: { cookie } })).status).toBe(401);
  });
});

describe('§14 server — lockout (5 failures → 15 minutes)', () => {
  it('locks only the failing source and unlocks after 15 minutes', async () => {
    const app = h.lanApp();
    for (let i = 1; i <= 4; i++) expect((await login(app, 'bad', 'mallory')).status).toBe(401);
    const fifth = await login(app, 'bad', 'mallory');
    expect(fifth.status).toBe(429);
    expect(await errorCode(fifth)).toBe('locked');
    // even the right password is refused while locked
    expect((await login(app, TEST_PASSWORD, 'mallory')).status).toBe(429);
    // another source is unaffected
    expect((await login(app, TEST_PASSWORD, 'alice')).status).toBe(200);
    h.clock.advance(15 * 60_000);
    expect((await login(app, TEST_PASSWORD, 'mallory')).status).toBe(200);
  });

  it('a success resets the failure count', () => {
    const lockout = new Lockout(h.clock, 3, 1000);
    lockout.fail('s');
    lockout.fail('s');
    lockout.succeed('s');
    expect(lockout.fail('s')).toBe(false);
    expect(lockout.lockedUntil('s')).toBeUndefined();
  });
});

describe('§14 server — Origin allow-list and Sec-Fetch-Site', () => {
  it('rejects a foreign Origin and cross-site fetches with 403', async () => {
    const app = h.lanApp();
    const cookie = cookieOf(await login(app));
    const evil = await lanRequest(app, '/api/state', {
      headers: { cookie, origin: 'http://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(await errorCode(evil)).toBe('forbidden');
    const crossSite = await lanRequest(app, '/api/state', {
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const sameSite = await lanRequest(app, '/api/state', {
      headers: { cookie, 'sec-fetch-site': 'same-site' },
    });
    expect(sameSite.status).toBe(403);
    const loginCsrf = await lanRequest(app, '/auth/login', {
      body: { password: TEST_PASSWORD },
      headers: { origin: 'http://evil.example' },
    });
    expect(loginCsrf.status).toBe(403);
  });

  it('accepts the listener’s own origin, Sec-Fetch-Site none, and configured origins', async () => {
    const app = h.lanApp({ allowed_origins: ['http://board.example:8080'] });
    const cookie = cookieOf(await login(app));
    for (const headers of [
      { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { origin: 'http://board.example:8080', 'sec-fetch-site': 'cross-site' },
    ]) {
      const res = await lanRequest(app, '/api/state', { headers: { cookie, ...headers } });
      expect(res.status).toBe(200);
    }
  });
});

describe('§14 server — routes forbidden on the LAN', () => {
  it('POST /api/projects is 403 lan_forbidden; reads and task actions stay open', async () => {
    const app = h.lanApp();
    const cookie = cookieOf(await login(app));
    const res = await lanRequest(app, '/api/projects', {
      body: { name: 'demo', repo_path: '/repos/demo' },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('lan_forbidden');
    expect(h.store.projects.list()).toEqual([]);
    expect((await lanRequest(app, '/api/projects', { headers: { cookie } })).status).toBe(200);
    const attention = await lanRequest(app, '/api/attention', {
      body: { question: 'Q?' },
      headers: { cookie, origin: ORIGIN },
    });
    expect(attention.status).toBe(201);
  });

  it('serves the placeholder board page without credentials in the URL', async () => {
    const res = await lanRequest(h.lanApp(), '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('agent-team');
    expect(html).not.toContain(TEST_PASSWORD);
  });

  it('serves a built board: assets, index fallback for client routes, API still guarded', async () => {
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
        const route = await lanRequest(app, '/tasks/t_000001');
        expect(route.status).toBe(200);
        expect(await route.text()).toContain('<title>board</title>');
        expect((await lanRequest(app, '/api/state')).status).toBe(401);
        expect((await lanRequest(app, '/api/nope')).status).toBe(401);
      } finally {
        await built.cleanup();
      }
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('login validates its body (400) before checking the password', async () => {
    const app = h.lanApp();
    const res = await lanRequest(app, '/auth/login', { body: {}, headers: { origin: ORIGIN } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('validation_failed');
  });
});

describe('secrets helpers', () => {
  it('constantTimeEqual compares strings of any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });

  it('SessionSigner rejects malformed values', () => {
    const signer = new SessionSigner(h.clock, 1000);
    const { value } = signer.issue();
    expect(signer.verify(value)).toBeDefined();
    for (const bad of [undefined, '', 'a.b', 'a.b.c.d', value.replace(/\.\d+\./, '.x.')]) {
      expect(signer.verify(bad)).toBeUndefined();
    }
  });
});
