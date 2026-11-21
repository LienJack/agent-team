import { afterEach, describe, expect, it } from 'vitest';
import { bootLeader, type FakeClaude, turnSteps } from '../testing/fake-claude.js';
import { createTestService, local, type Loose, type TestService } from '../testing/harness.js';
import type { LeaderImpl } from './leader.js';

// POST /api/leader/messages `wait` (spec §11; a leader turn may outlast the 300 s header
// timeout of Node's fetch): `wait: false` answers at once with `pending: true`; `wait: true`
// answers `pending: true` after `leader.reply_wait_ms` instead of an error; the reply is then
// read with GET /api/leader/messages/{id}.

let h: TestService;
let fake: FakeClaude;
const leader = () => h.service.leader as LeaderImpl;

afterEach(async () => {
  await h.cleanup();
});

async function post(body: Record<string, unknown>) {
  const res = await h.localApp().request('/api/leader/messages', local({ source: 'cli', ...body }));
  return { status: res.status, body: (await res.json()) as Loose };
}

async function get(id: string) {
  const res = await h.localApp().request(`/api/leader/messages/${id}`, local());
  return { status: res.status, body: (await res.json()) as Loose };
}

describe('§9 leader messages: non-blocking and capped waiting', () => {
  it('wait: false stores and queues the message and answers pending at once', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps({ text: '好的，已排入', delayMs: 150 }));
    await h.service.start();

    const sent = await post({ text: '排一個任務', client_msg_id: 'nb-1', wait: false });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ pending: true, reply: null, reply_message_id: null });
    expect(sent.body.leader).toMatchObject({ available: true });
    const id = sent.body.message_id as string;

    const before = await get(id);
    expect(before.body).toMatchObject({ message: { id, status: 'new' }, reply: null });

    await leader().settled();
    const after = await get(id);
    expect(after.body.message.status).toBe('delivered');
    expect(after.body.reply).toMatchObject({ direction: 'out', body: '好的，已排入', ref: id });
    const replied = h.store.events.listAfter(0).filter((e) => e.type === 'leader.reply');
    expect(replied.map((e) => e.data)).toEqual([
      { message_id: after.body.reply.id, in_reply_to: id, channel: 'leader' },
    ]);
    // a repeat with the same client_msg_id now returns the stored reply
    const again = await post({ text: '排一個任務', client_msg_id: 'nb-1', wait: false });
    expect(again.body).toMatchObject({ pending: false, reply: '好的，已排入', message_id: id });
    expect(fake.turns()).toHaveLength(1);
  });

  it('wait: true answers pending after leader.reply_wait_ms (no error), the turn goes on', async () => {
    ({ h, fake } = bootLeader((c) => void (c.leader.reply_wait_ms = 50)));
    await fake.set(turnSteps({ text: '查好了', delayMs: 600 }));
    await h.service.start();

    const started = Date.now();
    const sent = await post({ text: '查一下', client_msg_id: 'cap-1' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(sent).toMatchObject({ status: 200, body: { pending: true, reply: null } });
    await leader().settled();
    const done = await get(sent.body.message_id);
    expect(done.body.reply.body).toBe('查好了');
  });

  it('wait: true still returns the reply directly when the turn is quick', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps({ text: '馬上回' }));
    await h.service.start();
    const sent = await post({ text: '快問', client_msg_id: 'q-1' });
    expect(sent.body).toMatchObject({ pending: false, reply: '馬上回' });
    expect(sent.body.reply_message_id).toMatch(/^m_/);
  });

  it('a leader that is off: wait: false stores it and says why; wait: true is 503', async () => {
    h = createTestService(); // no leader conversation in this process
    await h.service.start();
    const sent = await post({ text: '在嗎', client_msg_id: 'off-1', wait: false });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      pending: true,
      leader: { available: false, reason: 'disabled' },
    });
    expect(h.store.messages.list().map((m) => [m.client_msg_id, m.status])).toEqual([
      ['off-1', 'new'],
    ]);
    const blocking = await post({ text: '在嗎', client_msg_id: 'off-2' });
    expect(blocking.status).toBe(503);
    expect(blocking.body.error.code).toBe('unavailable');
  });

  it('GET /api/leader/messages/{id} is for leader-channel inputs only', async () => {
    h = createTestService();
    await h.service.start();
    expect((await get('m_999999')).status).toBe(404);
    const { message } = h.service.engine.recordMessage({
      channel: 'grok',
      direction: 'in',
      source: 'grok',
      body: 'x',
      client_msg_id: 'g-1',
    });
    expect((await get(message.id)).status).toBe(404);
  });
});
