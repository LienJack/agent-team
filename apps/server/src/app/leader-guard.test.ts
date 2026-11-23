import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  local,
  TEST_LEADER_TOKEN,
  type Loose,
  type TestService,
} from '../testing/harness.js';

// spec §1 principle 1 / §9: the leader's `team` subset excludes run logs and transcripts. The
// server enforces it for the leader actor — the leader-scoped token on the local listener.

let h: TestService;

beforeEach(() => {
  h = createTestService();
});
afterEach(async () => {
  await h.cleanup();
});

const LEADER = TEST_LEADER_TOKEN;

async function call(path: string, body?: unknown, token?: string) {
  const res = await h.localApp().request(path, local(body, {}, token));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Loose };
}

describe('§9 leader-forbidden routes', () => {
  it('refuses run logs, transcripts, chat, the event stream and reset to the leader actor', async () => {
    const msg = { text: 'hi', source: 'cli', client_msg_id: 'g-1' };
    const forbidden: Array<[string, unknown]> = [
      ['/api/runs/r_000001/log', undefined],
      ['/api/leader/messages', undefined],
      ['/api/leader/messages', msg],
      ['/api/leader/messages/m_000001', undefined],
      ['/api/events', undefined],
      ['/api/leader/reset', {}],
      ['/api/projects', { name: 'x', repo_path: '/tmp/x' }],
    ];
    for (const [path, body] of forbidden) {
      const res = await call(path, body, LEADER);
      expect({ path, status: res.status, code: res.body.error.code }).toEqual({
        path,
        status: 403,
        code: 'forbidden',
      });
      expect(res.body.error.hint).toMatch(/receipts/);
    }
    // nothing was stored for the refused chat message
    expect(h.store.messages.list()).toEqual([]);
    expect(h.store.projects.list()).toEqual([]);
  });

  it('allows the leader its working set and leaves humans unaffected', async () => {
    expect((await call('/api/state', undefined, LEADER)).status).toBe(200);
    expect((await call('/api/tasks', undefined, LEADER)).status).toBe(200);
    expect((await call('/api/resume', undefined, LEADER)).status).toBe(200);
    expect((await call('/api/attention', { question: 'Q?' }, LEADER)).status).toBe(201);
    expect((await call('/api/leader/messages')).status).toBe(200);
    expect((await call('/api/runs/r_000001/log')).status).toBe(404);
  });

  it("changing a project's checks is human-only", async () => {
    const p = h.service.engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
    const patch = (token?: string) =>
      h.localApp().request(`/api/projects/${p.id}`, {
        ...local({ checks: [{ name: 'test', cmd: 'pytest -q' }] }, {}, token),
        method: 'PATCH',
      });
    const refused = await patch(LEADER);
    expect(refused.status).toBe(403);
    expect(h.store.projects.get(p.id)?.checks).toEqual([]);
    const done = await patch();
    expect(done.status).toBe(200);
    expect(((await done.json()) as Loose).project.checks).toEqual([
      { name: 'test', cmd: 'pytest -q' },
    ]);
  });

  it('attention answers are human-only; the channel comes from the credential', async () => {
    const q = h.service.engine.openAttention({ question: 'Q?', options: ['A', 'B'] });
    const res = await call(`/api/attention/${q.id}/answer`, { answer: 'A', via: 'cli' }, LEADER);
    expect(res.status).toBe(403);
    const own = await call(`/api/attention/${q.id}/answer`, { answer: 'A', via: 'cli' });
    expect(own.body.attention.answered_via).toBe('cli');
  });
});
