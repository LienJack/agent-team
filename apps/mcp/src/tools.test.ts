import { TeamApiError, type TeamClient } from '@agent-team/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_RUNNING_MESSAGE } from './errors.js';
import { createServer } from './server.js';

const task = (over: Record<string, unknown> = {}) => ({
  id: 't_aaa',
  title: 'Add a',
  tier: 'C',
  impl_role: 'impl_C',
  status: 'running',
  ...over,
});
const attention = (over: Record<string, unknown> = {}) => ({
  id: 'a_1',
  task_id: 't_aaa',
  kind: 'decision',
  question: 'Which db?',
  options: ['sqlite', 'pg'],
  status: 'open',
  answer: null,
  ...over,
});

type Fake = Record<string, unknown>;
const mock = <A extends unknown[], R>(impl: (...a: A) => R) => vi.fn<(...a: A) => R>(impl);
const clients: Client[] = [];

async function connect(fake: Fake | (() => Promise<TeamClient>)) {
  const provider = typeof fake === 'function' ? fake : async () => fake as unknown as TeamClient;
  const server = createServer(provider);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}
const text = (r: unknown) =>
  ((r as { content: unknown }).content as Array<{ type: string; text: string }>)[0]!.text;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('tool list', () => {
  it('exposes exactly the thin tools (two for research, four for memory, one gate; spec §17–§19), with descriptions', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_memory',
      'add_research',
      'answer_attention',
      'ask_leader',
      'gate_worktree',
      'list_attention',
      'list_memory',
      'remove_memory',
      'search_memory',
      'show_research',
      'status',
      'task_action',
    ]);
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(20);
  });
});

describe('ask_leader', () => {
  const leader = { state: 'idle', last_activity_at: null, available: true };

  it('posts source mcp with a generated client_msg_id and returns only the reply', async () => {
    const sendLeaderMessage = mock(async (_body: { client_msg_id: string }, _opts?: unknown) => ({
      message_id: 'm_1',
      pending: false,
      reply: 'On it.',
      reply_message_id: 'm_2',
      leader,
    }));
    const client = await connect({ sendLeaderMessage });
    const r = await client.callTool({ name: 'ask_leader', arguments: { text: 'ship it' } });
    expect(text(r)).toBe('On it.');
    expect(sendLeaderMessage).toHaveBeenCalledWith(
      {
        text: 'ship it',
        source: 'mcp',
        client_msg_id: expect.stringMatching(/^mcp-[0-9a-f-]{36}$/),
        wait: true,
      },
      expect.anything(),
    );
    await client.callTool({ name: 'ask_leader', arguments: { text: 'again' } });
    const ids = sendLeaderMessage.mock.calls.map(
      (c) => (c[0] as { client_msg_id: string }).client_msg_id,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps waiting past the server cap (pending) until the reply exists', async () => {
    const inbound = {
      id: 'm_1',
      channel: 'leader',
      direction: 'in',
      source: 'mcp',
      body: 'long one',
      client_msg_id: 'x',
      ref: null,
      status: 'new',
      seq: 1,
      created_at: '2026-11-21T00:00:00.000Z',
    };
    let polls = 0;
    const sendLeaderMessage = mock(async () => ({
      message_id: 'm_1',
      pending: true,
      reply: null,
      reply_message_id: null,
      leader,
    }));
    const leaderMessage = mock(async () => {
      polls += 1;
      return {
        message: inbound,
        reply: polls < 2 ? null : { ...inbound, id: 'm_2', direction: 'out', body: 'Done.' },
        leader,
      };
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const client = await connect({ sendLeaderMessage, leaderMessage });
      const call = client.callTool({ name: 'ask_leader', arguments: { text: 'long one' } });
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      const r = await call;
      expect(text(r)).toBe('Done.');
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects empty text without calling the client', async () => {
    const sendLeaderMessage = mock(async () => undefined);
    const client = await connect({ sendLeaderMessage });
    const r = await client.callTool({ name: 'ask_leader', arguments: { text: '' } });
    expect(r.isError).toBe(true);
    expect(sendLeaderMessage).not.toHaveBeenCalled();
  });
});

describe('status', () => {
  it('summarises the board compactly', async () => {
    const state = mock(async () => ({
      tasks: [
        task({ id: 't_1', status: 'queued' }),
        task({ id: 't_2', status: 'running' }),
        task({ id: 't_3', status: 'done' }),
        task({ id: 't_4', status: 'cancelled' }),
      ],
      active_runs: [{ task_id: 't_2', runner: 'dsh', model_alias: 'deepseek-flash', kind: 'impl' }],
      open_attention: [attention()],
      runners: [
        {
          runner: 'claude',
          available: true,
          circuit: 'closed',
          quota: { utilization: 0.42, exhausted: false },
        },
        { runner: 'codex', available: false, circuit: 'open', cooldown_until: null, quota: null },
        { runner: 'dsh', available: true, circuit: 'closed', quota: null },
      ],
      leader: { state: 'idle' },
    }));
    const client = await connect({ state });
    const r = await client.callTool({ name: 'status', arguments: {} });
    const out = text(r);
    expect(out).toContain('board: pending 1 · in_progress 1 · review 0 · blocked 0 · done 1');
    expect(out).toContain('t_2 [running] C impl_C Add a ← dsh/deepseek-flash (impl)');
    expect(out).not.toContain('t_4');
    expect(out).toContain('attention: 1 open');
    expect(out).toContain('claude ok quota 42% · codex circuit open · dsh ok');
    expect(out).toContain('leader: idle');
    expect(out.split('\n').length).toBeLessThan(40);
  });

  it('caps the running list', async () => {
    const tasks = Array.from({ length: 60 }, (_, i) => task({ id: `t_${i}`, status: 'running' }));
    const client = await connect({
      state: async () => ({
        tasks,
        active_runs: [],
        open_attention: [],
        runners: [],
        leader: { state: 'busy' },
      }),
    });
    const out = text(await client.callTool({ name: 'status', arguments: {} }));
    expect(out.split('\n').length).toBeLessThan(40);
    expect(out).toContain('and 48 more');
  });
});

describe('attention tools', () => {
  it('lists open items with options', async () => {
    const listAttention = mock(async () => [attention()]);
    const client = await connect({ listAttention });
    const r = await client.callTool({ name: 'list_attention', arguments: {} });
    expect(listAttention).toHaveBeenCalledWith({ status: 'open' });
    expect(text(r)).toBe('a_1 [decision] task t_aaa Which db? options: sqlite | pg');
  });

  it('says so when nothing is open', async () => {
    const client = await connect({ listAttention: async () => [] });
    expect(text(await client.callTool({ name: 'list_attention', arguments: {} }))).toBe(
      'no open attention items',
    );
  });

  it('answers via mcp', async () => {
    const answerAttention = mock(async () => attention({ status: 'answered', answer: 'sqlite' }));
    const client = await connect({ answerAttention });
    const r = await client.callTool({
      name: 'answer_attention',
      arguments: { id: 'a_1', answer: 'sqlite' },
    });
    expect(answerAttention).toHaveBeenCalledWith('a_1', { answer: 'sqlite', via: 'mcp' });
    expect(text(r)).toBe('a_1 answered: sqlite');
  });

  it('validates input', async () => {
    const answerAttention = mock(async () => undefined);
    const client = await connect({ answerAttention });
    const r = await client.callTool({ name: 'answer_attention', arguments: { id: 'a_1' } });
    expect(r.isError).toBe(true);
    expect(answerAttention).not.toHaveBeenCalled();
  });
});

describe('task_action', () => {
  const fake = () => ({
    taskAction: mock(async (id: string) => task({ id, status: 'queued' })),
    rejectTask: mock(async (id: string) => task({ id, status: 'running' })),
    reassignTask: mock(async (id: string) => task({ id, impl_role: 'impl_B' })),
  });

  it.each(['queue', 'cancel', 'retry', 'approve'])('%s calls taskAction', async (action) => {
    const f = fake();
    const client = await connect(f);
    const r = await client.callTool({ name: 'task_action', arguments: { id: 't_aaa', action } });
    expect(f.taskAction).toHaveBeenCalledWith('t_aaa', action);
    expect(text(r)).toBe('t_aaa [queued] C impl_C Add a');
  });

  it('reassign needs and passes a role', async () => {
    const f = fake();
    const client = await connect(f);
    const bad = await client.callTool({
      name: 'task_action',
      arguments: { id: 't_aaa', action: 'reassign' },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe('bad_request: reassign needs `role`');
    const ok = await client.callTool({
      name: 'task_action',
      arguments: { id: 't_aaa', action: 'reassign', role: 'impl_B' },
    });
    expect(f.reassignTask).toHaveBeenCalledWith('t_aaa', 'impl_B');
    expect(text(ok)).toContain('impl_B');
  });

  it('reject needs and passes a note', async () => {
    const f = fake();
    const client = await connect(f);
    const bad = await client.callTool({
      name: 'task_action',
      arguments: { id: 't_aaa', action: 'reject' },
    });
    expect(bad.isError).toBe(true);
    await client.callTool({
      name: 'task_action',
      arguments: { id: 't_aaa', action: 'reject', note: 'missing tests' },
    });
    expect(f.rejectTask).toHaveBeenCalledWith('t_aaa', 'missing tests');
  });

  it('rejects unknown actions', async () => {
    const f = fake();
    const client = await connect(f);
    const r = await client.callTool({
      name: 'task_action',
      arguments: { id: 't_aaa', action: 'nuke' },
    });
    expect(r.isError).toBe(true);
    expect(f.taskAction).not.toHaveBeenCalled();
  });
});

describe('error mapping', () => {
  it('maps TeamApiError to code: message (hint)', async () => {
    const client = await connect({
      taskAction: async () => {
        throw new TeamApiError(
          { code: 'invalid_transition', message: 'cannot retry a done task', hint: 'see status' },
          409,
        );
      },
    });
    const r = await client.callTool({
      name: 'task_action',
      arguments: { id: 't_1', action: 'retry' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('invalid_transition: cannot retry a done task (see status)');
  });

  it('omits the hint when there is none', async () => {
    const client = await connect({
      answerAttention: async () => {
        throw new TeamApiError({ code: 'not_found', message: 'no such attention' }, 404);
      },
    });
    const r = await client.callTool({
      name: 'answer_attention',
      arguments: { id: 'a_x', answer: 'y' },
    });
    expect(text(r)).toBe('not_found: no such attention');
  });

  it('tells the user to run `team serve` when the service is down', async () => {
    const down = new TeamApiError(
      {
        code: 'unavailable',
        message: 'cannot reach agent-team',
        hint: 'start the service with `team serve`',
      },
      0,
    );
    // down at connect time (listener.json missing) and down mid-request
    for (const client of [
      await connect(async () => {
        throw down;
      }),
      await connect({ state: async () => Promise.reject(down) }),
    ]) {
      const r = await client.callTool({ name: 'status', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(NOT_RUNNING_MESSAGE);
      expect(text(r)).toContain('team serve');
      expect(text(r)).not.toContain('\n');
    }
  });

  it('maps unexpected errors to internal', async () => {
    const client = await connect({ state: async () => Promise.reject(new Error('boom')) });
    expect(text(await client.callTool({ name: 'status', arguments: {} }))).toBe('internal: boom');
  });
});
