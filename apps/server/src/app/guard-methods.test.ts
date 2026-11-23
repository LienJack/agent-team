import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  local,
  TEST_LEADER_TOKEN,
  type Loose,
  type TestService,
} from '../testing/harness.js';

// The leader route guard compares methods the way the router does: HEAD is answered by
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
});
