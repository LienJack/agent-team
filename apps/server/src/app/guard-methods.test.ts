import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  local,
  SOURCE_HEADER,
  TEST_LEADER_TOKEN,
  TEST_PASSWORD,
  type Loose,
  type TestService,
} from '../testing/harness.js';

// The leader and LAN route guards compare methods the way the router does: HEAD is answered by
// the GET handler (headers such as content-length would leak), so it is guarded as GET; on a
// guarded path, a method no route registers (PUT, PATCH, DELETE, …) is refused rather than left
// to whatever the router does with it.

let h: TestService;
beforeEach(() => {
  h = createTestService();
});
afterEach(async () => {
  await h.cleanup();
});

const errorCode = async (res: Response) => ((await res.json()) as Loose).error.code as string;

describe('route guards: HEAD and unregistered methods', () => {
  it('refuses HEAD of a leader-forbidden GET route and unknown methods on it', async () => {
    // no run needs to exist: the guard answers before the handler
    const head = await h.localApp().request('/api/runs/r_000001/log', {
      ...local(undefined, {}, TEST_LEADER_TOKEN),
      method: 'HEAD',
    });
    expect(head.status).toBe(403);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await h.localApp().request('/api/runs/r_000001/log', {
        ...local(undefined, {}, TEST_LEADER_TOKEN),
        method,
      });
      expect({ method, status: res.status, code: await errorCode(res) }).toEqual({
        method,
        status: 403,
        code: 'forbidden',
      });
    }
    // humans keep HEAD on the same route (served by the GET handler: no such run)
    const human = await h
      .localApp()
      .request('/api/runs/r_000001/log', { ...local(), method: 'HEAD' });
    expect(human.status).toBe(404);
  });

  it('refuses unregistered methods on a LAN-forbidden path; HEAD of its GET stays open', async () => {
    const HOST = '192.168.1.20:4518';
    const ORIGIN = `http://${HOST}`;
    const app = h.lanApp();
    const req = (
      path: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> },
    ) =>
      app.request(`http://${HOST}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          host: HOST,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    const login = await req('/auth/login', {
      body: { password: TEST_PASSWORD },
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', [SOURCE_HEADER]: 'a' },
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await req('/api/projects', { method, headers: { cookie, origin: ORIGIN } });
      expect({ method, status: res.status, code: await errorCode(res) }).toEqual({
        method,
        status: 403,
        code: 'lan_forbidden',
      });
    }
    expect((await req('/api/projects', { method: 'HEAD', headers: { cookie } })).status).toBe(200);
  });
});
