import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_LAYOUT } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootLeader,
  type FakeClaude,
  notLoggedInSteps,
  rateLimitedSteps,
  turnSteps,
} from '../testing/fake-claude.js';
import { local, type Loose, type TestService } from '../testing/harness.js';
import type { LeaderImpl } from './leader.js';
import { LEADER_SESSION_KEY } from './types.js';

// spec §9 額度與登入: a rate limit or a missing login makes the leader unavailable without
// dropping anything; `resetSession()` (POST /api/leader/reset, `team leader reset`) continues
// in a new conversation.

let h: TestService;
let fake: FakeClaude;
const leader = () => h.service.leader as LeaderImpl;
const HOUR = 3_600_000;

async function send(text: string, id: string) {
  const res = await h
    .localApp()
    .request('/api/leader/messages', local({ text, source: 'cli', client_msg_id: id }));
  return { status: res.status, body: (await res.json()) as Loose };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusEvents = () =>
  h.store.events
    .listAfter(0)
    .filter((e) => e.type === 'leader.status_changed')
    .map((e) => e.data);

afterEach(async () => {
  await h.cleanup();
});

describe('§9 leader availability (fake claude)', () => {
  it('rate limit: unavailable until the reset, messages stay queued, then answered in order', async () => {
    ({ h, fake } = bootLeader());
    const resetAt = h.clock.now().getTime() + HOUR;
    await fake.set(rateLimitedSteps(resetAt / 1000));
    await h.service.start();

    const a = await send('第一則', 'a');
    expect(a.status).toBe(503);
    expect(a.body.error.code).toBe('unavailable');
    expect(a.body.error.hint).toMatch(/自動重試/);
    const until1 = new Date(resetAt).toISOString();
    expect(h.service.leader.status()).toMatchObject({
      state: 'offline',
      available: false,
      reason: 'rate_limit',
      until: until1,
      queued: 1,
      quota: { utilization: 1, exhausted: true },
    });
    const b = await send('第二則', 'b');
    expect(b.status).toBe(503);
    expect(h.service.leader.status().queued).toBe(2);
    expect(fake.turns()).toHaveLength(1); // no turn while unavailable
    // the turn started (busy), then hit the limit (offline until the reset)
    expect(statusEvents()).toEqual([
      { state: 'busy', available: true, reason: null, until: null },
      { state: 'offline', available: false, reason: 'rate_limit', until: until1 },
    ]);
    // nothing was dropped: both inputs are stored and still `new`
    expect(h.store.messages.list().map((m) => [m.client_msg_id, m.status])).toEqual([
      ['a', 'new'],
      ['b', 'new'],
    ]);

    await fake.set(turnSteps({ text: '恢復了' }));
    leader().pump(); // before the reset time: still waiting
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.turns()).toHaveLength(1);
    h.clock.advance(HOUR + 1000);
    leader().pump();
    await until(() => fake.turns().length === 3);
    await leader().settled();
    const stdin = fake.turns().map((t) => t.stdin);
    expect(stdin[1]).toContain('第一則');
    expect(stdin[2]).toContain('第二則');
    expect(h.service.leader.status()).toMatchObject({ available: true, state: 'idle', queued: 0 });
    expect(statusEvents().at(-1)).toEqual({
      state: 'idle',
      available: true,
      reason: null,
      until: null,
    });
    // back to available, then one busy/idle pair per turn (no duplicates in between)
    expect(
      statusEvents()
        .slice(2)
        .map((e) => (e as { state: string }).state),
    ).toEqual(['idle', 'busy', 'idle']);
    // a retry with the same client_msg_id now returns the stored reply
    expect((await send('第一則', 'a')).body.reply).toBe('恢復了');
  });

  it('not logged in: unavailable with a hint; reset continues in a new session with the brief', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(notLoggedInSteps());
    await h.service.start();
    const first = await send('在嗎', 'x');
    expect(first.status).toBe(503);
    expect(h.service.leader.status()).toMatchObject({ reason: 'auth', available: false });
    expect(h.service.leader.status().hint).toMatch(/claude \/login.*team leader reset/);
    const oldSession = h.store.kv.get(LEADER_SESSION_KEY);

    await fake.set(turnSteps({ text: '在' }));
    const res = await h.localApp().request('/api/leader/reset', local({}));
    const body = (await res.json()) as Loose;
    expect(res.status).toBe(200);
    expect(body.session_id).not.toBe(oldSession);
    expect(body.leader).toMatchObject({ available: true });
    expect(h.store.kv.get(LEADER_SESSION_KEY)).toBe(body.session_id);
    await until(() => fake.turns().length === 2);
    await leader().settled();
    const turn = fake.turns()[1]!;
    expect(turn.argv).toContain('--session-id');
    expect(turn.argv[turn.argv.indexOf('--session-id') + 1]).toBe(body.session_id);
    expect(turn.stdin).toMatch(/^\[服務端現況摘要/);
    expect((await send('在嗎', 'x')).body.reply).toBe('在');
  });

  it('probe says not logged in: unavailable from the start, no turn is attempted', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps(), { loggedIn: false });
    await h.service.start();
    expect(h.service.leader.status()).toMatchObject({ reason: 'auth', state: 'offline' });
    expect((await send('hi', 'p')).status).toBe(503);
    expect(fake.turns()).toEqual([]);
  });

  it('a lost session (cannot resume) starts a new one with the brief', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps());
    await h.service.start();
    await send('一', '1');
    const first = h.store.kv.get(LEADER_SESSION_KEY)!;
    // resuming the old session fails; the new session's first turn answers (same argv as the
    // first turn, with --resume instead of --session-id: the settings JSON is identical)
    const firstArgv = fake.turns()[0]!.argv;
    const at = firstArgv.indexOf('--session-id');
    const resume = [...firstArgv.slice(0, at), '--resume', first, ...firstArgv.slice(at + 2)];
    await fake.set(turnSteps({ text: '新的' }), {
      responses: [
        { argv: resume, stderr: `No conversation found with session ID: ${first}`, exit: 1 },
      ],
    });
    expect((await send('二', '2')).body.reply).toBe('新的');
    const turns = fake.turns();
    expect(turns[1]!.argv).toContain('--resume');
    expect(turns[2]!.argv).toContain('--session-id');
    expect(h.store.kv.get(LEADER_SESSION_KEY)).not.toBe(first);
    expect(turns[2]!.stdin).toMatch(/^\[服務端現況摘要/);
  });

  it('a missing team CLI keeps the leader offline (not_installed); messages are stored', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps());
    rmSync(join(h.root, 'team-bin.js'));
    await h.service.start();
    expect(h.service.leader.status()).toMatchObject({ reason: 'not_installed', state: 'offline' });
    expect(h.service.leader.status().hint).toMatch(/pnpm build/);
    expect((await send('hi', 'n')).status).toBe(503);
    expect(h.store.messages.findByClientMsgId('leader', 'n')).toBeDefined();
    expect(fake.turns()).toEqual([]);
  });

  it('a leader socket that cannot be bound keeps the leader offline, also after a reset', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps());
    // something that is not a socket sits where the leader's API socket goes: the bind fails
    mkdirSync(join(h.dataDir, 'leader'), { recursive: true });
    writeFileSync(join(h.dataDir, DATA_LAYOUT.leaderSocket), 'not a socket\n');
    await h.service.start();
    expect(h.service.leader.status()).toMatchObject({
      state: 'offline',
      available: false,
      reason: 'not_installed',
    });
    expect(h.service.leader.status().hint).toMatch(/API socket could not be bound/);
    expect((await send('hi', 's')).status).toBe(503);
    await h.service.leader.resetSession();
    expect(h.service.leader.status()).toMatchObject({ available: false, reason: 'not_installed' });
    expect(fake.turns()).toEqual([]);
    expect(h.store.messages.findByClientMsgId('leader', 's')?.status).toBe('new');
  });

  it('stopping during a turn keeps the message for the next start', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps({ delayMs: 5000 }));
    await h.service.start();
    const pending = send('長的', 'long');
    await until(() => fake.turns().length === 1);
    await h.service.stop();
    expect((await pending).status).toBe(503);
    expect(h.store.messages.findByClientMsgId('leader', 'long')?.status).toBe('new');
  });
});
