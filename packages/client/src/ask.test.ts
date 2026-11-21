import { describe, expect, it } from 'vitest';
import { AskAbortedError, askLeader, pollOutcome } from './ask.js';
import type { LeaderMessageDetail, LeaderReply, TeamClient } from './client.js';
import { TeamApiError } from './errors.js';

// `team ask` / MCP `ask_leader` (spec §12): wait for the reply however long the leader turn takes
// (the POST answers `pending` after the server's cap; then GET /api/leader/messages/{id}).

const leader = (over: Partial<LeaderReply['leader']> = {}): LeaderReply['leader'] => ({
  state: 'busy',
  last_activity_at: null,
  available: true,
  reason: null,
  hint: null,
  until: null,
  ...over,
});

const message = (status: 'new' | 'delivered' = 'new') => ({
  id: 'm_1',
  channel: 'leader' as const,
  direction: 'in' as const,
  source: 'cli' as const,
  body: 'hi',
  client_msg_id: 'c1',
  ref: null,
  status,
  seq: 1,
  created_at: '2026-11-21T00:00:00.000Z',
});

const replyMsg = { ...message('new'), id: 'm_2', direction: 'out' as const, body: '好的' };

function fakeClient(
  first: LeaderReply,
  polls: Array<LeaderMessageDetail | Error>,
): { client: TeamClient; posts: unknown[]; gets: number } {
  const state = { posts: [] as unknown[], gets: 0 };
  const client = {
    sendLeaderMessage: async (body: unknown) => {
      state.posts.push(body);
      return first;
    },
    leaderMessage: async () => {
      const next = polls[Math.min(state.gets, polls.length - 1)]!;
      state.gets++;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as TeamClient;
  return {
    client,
    get posts() {
      return state.posts;
    },
    get gets() {
      return state.gets;
    },
  };
}

const pending: LeaderReply = {
  message_id: 'm_1',
  pending: true,
  reply: null,
  reply_message_id: null,
  leader: leader(),
};

describe('askLeader', () => {
  it('returns a reply that came back within the server cap without polling', async () => {
    const f = fakeClient(
      {
        message_id: 'm_1',
        pending: false,
        reply: '完成',
        reply_message_id: 'm_2',
        leader: leader(),
      },
      [],
    );
    const out = await askLeader(f.client, { text: 'hi', source: 'cli', clientMsgId: 'c1' });
    expect(out).toEqual({ reply: '完成', message_id: 'm_1', reply_message_id: 'm_2' });
    expect(f.posts).toEqual([{ text: 'hi', source: 'cli', client_msg_id: 'c1', wait: true }]);
    expect(f.gets).toBe(0);
  });

  it('polls a pending message until its reply exists', async () => {
    const waiting = { message: message(), reply: null, leader: leader() };
    const f = fakeClient(pending, [waiting, waiting, { ...waiting, reply: replyMsg }]);
    const seen: string[] = [];
    const out = await askLeader(f.client, {
      text: 'hi',
      source: 'cli',
      pollMs: 1,
      onPending: ({ messageId }) => seen.push(messageId),
    });
    expect(out).toEqual({ reply: '好的', message_id: 'm_1', reply_message_id: 'm_2' });
    expect(f.gets).toBe(3);
    expect(seen).toEqual(['m_1']);
  });

  it('stops when the leader handled the message without a reply (failed turn)', async () => {
    const f = fakeClient(pending, [
      { message: message('delivered'), reply: null, leader: leader() },
    ]);
    const err = await askLeader(f.client, { text: 'hi', source: 'cli', pollMs: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TeamApiError);
    expect(err).toMatchObject({ code: 'conflict' });
  });

  it('stops with the leader’s hint when it cannot answer soon (login, limit, off)', async () => {
    const off = leader({
      available: false,
      state: 'offline',
      reason: 'auth',
      hint: 'claude /login',
    });
    const f = fakeClient(pending, [{ message: message(), reply: null, leader: off }]);
    const err = await askLeader(f.client, { text: 'hi', source: 'cli', pollMs: 1 }).catch(
      (e: unknown) => e as TeamApiError,
    );
    expect(err).toMatchObject({ code: 'unavailable', hint: 'claude /login' });
    expect((err as TeamApiError).message).toContain('m_1');
  });

  it('keeps waiting while the leader is only starting (no reason)', () => {
    const starting = leader({ available: false, state: 'offline', reason: null });
    expect(pollOutcome({ message: message(), reply: null, leader: starting })).toEqual({
      wait: true,
    });
  });

  it('an abort ends the wait with AskAbortedError carrying the message id', async () => {
    const controller = new AbortController();
    const waiting = { message: message(), reply: null, leader: leader() };
    const f = fakeClient(pending, [waiting]);
    const done = askLeader(f.client, {
      text: 'hi',
      source: 'cli',
      pollMs: 5,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 20);
    const err = await done;
    expect(err).toBeInstanceOf(AskAbortedError);
    expect((err as AskAbortedError).messageId).toBe('m_1');
  });
});
