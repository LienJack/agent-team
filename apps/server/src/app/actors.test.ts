import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  local,
  TEST_LEADER_TOKEN,
  TEST_PASSWORD,
  type Loose,
  type TestService,
} from '../testing/harness.js';

// docs/adr/0014: the server derives the actor from the credential. The operator token
// (listener.json) and a LAN session are `human`; the leader-scoped token (leader/listener.json,
// used by the leader's `team` shim) is `leader`; anything else is refused. No request header or
// body field can claim an actor, a message source or an answer channel.

let h: TestService;
beforeEach(() => {
  h = createTestService();
});
afterEach(async () => {
  await h.cleanup();
});

async function call(path: string, body?: unknown, token?: string, headers = {}) {
  const res = await h.localApp().request(path, local(body, headers, token));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Loose };
}
const leader = (path: string, body?: unknown) => call(path, body, TEST_LEADER_TOKEN);

function reviewTask() {
  const engine = h.service.engine;
  const project = engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
  const task = engine.createTask({
    project_id: project.id,
    title: 't',
    tier: 'C',
    ticket_md: '#',
    owned_paths: ['src/'],
  });
  // move it to review directly (the routes only need the status); reviewers hold
  for (const r of Object.values(h.runners)) r.defaultStep = { hold: true };
  h.store.atomic((r) => {
    const t = r.tasks.get(task.id)!;
    r.tasks.update({ ...t, status: 'review' }, t.version);
  });
  return task;
}

describe('H1 actor from the credential', () => {
  it('X-Team-Actor grants nothing: the operator token stays human, the leader token stays leader', async () => {
    // operator token + forged header: still human (a missing run is 404, not the leader's 403)
    const forged = await call('/api/runs/r_000001/log', undefined, undefined, {
      'x-team-actor': 'leader',
    });
    expect(forged.status).toBe(404);
    // leader token without any header: leader
    expect((await leader('/api/runs/r_000001/log')).status).toBe(403);
    // an unknown token is refused
    expect((await call('/api/state', undefined, 'not-a-token-0000000000')).status).toBe(401);
  });

  it('human-only operations are refused to the leader token', async () => {
    const task = reviewTask();
    const item = h.service.engine.openAttention({ question: 'Q?', options: ['A'] });
    const refused: Array<[string, unknown]> = [
      [`/api/tasks/${task.id}/approve`, {}],
      [`/api/tasks/${task.id}/reject`, { note: 'no' }],
      [`/api/tasks/${task.id}/reassign`, { role: 'impl_B' }],
      [`/api/attention/${item.id}/answer`, { answer: 'A' }],
      ['/api/projects', { name: 'other', repo_path: '/repos/other' }],
      ['/api/leader/reset', {}],
    ];
    for (const [path, body] of refused) {
      const res = await leader(path, body);
      expect({ path, status: res.status, code: res.body.error.code }).toEqual({
        path,
        status: 403,
        code: 'forbidden',
      });
    }
    expect(h.store.tasks.get(task.id)!.status).toBe('review');
    expect(h.store.attention.get(item.id)!.status).toBe('open');
    // a human with the operator token can
    expect((await call(`/api/tasks/${task.id}/approve`, {})).status).toBe(200);
    expect((await call(`/api/attention/${item.id}/answer`, { answer: 'A' })).status).toBe(200);
  });

  it('the leader keeps its working set', async () => {
    expect((await leader('/api/state')).status).toBe(200);
    expect((await leader('/api/attention', { question: 'Q?' })).status).toBe(201);
  });
});

describe('L9c source and via come from the listener and the credential, never the body', () => {
  it('operator token: always cli, whatever the body claims', async () => {
    for (const source of [undefined, 'mcp', 'grok', 'service', 'web']) {
      const res = await call('/api/leader/messages', {
        text: 'hi',
        ...(source ? { source } : {}),
        client_msg_id: `c-${source ?? 'none'}`,
        wait: false,
      });
      expect(res.status).toBe(200);
      expect({ source, stored: h.store.messages.get(res.body.message_id)!.source }).toEqual({
        source,
        stored: 'cli',
      });
    }
    const q = h.service.engine.openAttention({ question: 'Q?', options: ['A'] });
    const spoof = await call(`/api/attention/${q.id}/answer`, { answer: 'A', via: 'grok' });
    expect(spoof.body.attention.answered_via).toBe('cli');
  });

  it('LAN session: always web', async () => {
    const app = h.lanApp();
    const host = '192.168.1.20:4518';
    const headers = { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' };
    const login = await app.request(`http://${host}/auth/login`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const post = (path: string, body: unknown) =>
      app.request(`http://${host}${path}`, {
        method: 'POST',
        headers: { ...headers, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const source of [undefined, 'cli', 'grok']) {
      const res = await post('/api/leader/messages', {
        text: 'hi',
        ...(source ? { source } : {}),
        client_msg_id: `w-${source ?? 'none'}`,
        wait: false,
      });
      const id = ((await res.json()) as Loose).message_id as string;
      expect(h.store.messages.get(id)!.source).toBe('web');
    }
  });
});

describe('L9b server prefixes of client_msg_id are reserved', () => {
  it('refuses a client id that could shadow a leader reply', async () => {
    const res = await call('/api/leader/messages', {
      text: 'hi',
      client_msg_id: 'reply:m_000001',
      wait: false,
    });
    expect(res.status).toBe(400);
    expect(h.store.messages.list()).toEqual([]);
  });
});
