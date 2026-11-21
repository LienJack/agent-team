import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceConfig } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { bootLeader, compactSteps, type FakeClaude, turnSteps } from '../testing/fake-claude.js';
import { local, type Loose, type TestService } from '../testing/harness.js';
import type { LeaderImpl } from './leader.js';
import { LEADER_SYSTEM_PROMPT } from './prompt/system-v1.js';
import { LEADER_EVENT_CURSOR_KEY, LEADER_SESSION_KEY } from './types.js';

// spec §9 with the scripted fake CLI (never the real claude): argv, serial queue, priority,
// event digests, de-dup, compaction and the resume brief.

let h: TestService;
let fake: FakeClaude;
const leader = () => h.service.leader as LeaderImpl;

async function send(text: string, id: string, source = 'cli') {
  const res = await h
    .localApp()
    .request('/api/leader/messages', local({ text, source, client_msg_id: id }));
  return { status: res.status, body: (await res.json()) as Loose };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function start(configure?: (c: ServiceConfig) => void, steps = turnSteps()) {
  ({ h, fake } = bootLeader(configure));
  await fake.set(steps);
  await h.service.start();
}

afterEach(async () => {
  await h.cleanup();
});

describe('§9 leader turns (fake claude)', () => {
  it('first turn --session-id, then --resume; Bash allow-listed to team only; stdin closed', async () => {
    await start(undefined, turnSteps({ text: '目前沒有任務', commands: ['team status'] }));
    const first = await send('列出目前的任務狀態', 'c-1');
    expect(first).toMatchObject({ status: 200, body: { reply: '目前沒有任務' } });
    expect((await send('/clear', 'c-2')).status).toBe(200);

    const sid = h.store.kv.get(LEADER_SESSION_KEY)!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    const args = (session: string[]) => [
      '-p',
      '--model',
      'claude-sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
      ...session,
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--restricted',
      '--tools',
      'Bash',
      '--allowedTools',
      'Bash(team:*)',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--effort',
      'medium',
      '--append-system-prompt',
      LEADER_SYSTEM_PROMPT,
    ];
    const turns = fake.turns();
    expect(turns.map((t) => t.argv)).toEqual([
      args(['--session-id', sid]),
      args(['--resume', sid]),
    ]);
    for (const t of turns) {
      expect(t.argv.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
      expect(t.stdinClosed).toBe(true);
      // allow-listed environment only: no tokens, passwords or keys, no enclosing agent session
      // (macOS adds __CF_USER_TEXT_ENCODING to every process)
      expect(t.envNames.filter((n) => !n.startsWith('__CF_'))).toEqual([
        'HOME',
        'NO_COLOR',
        'PATH',
      ]);
      expect(t.cwd.endsWith(join('data', 'leader', 'cwd'))).toBe(true);
    }
    // a fresh session starts with the model-free brief; a human text never starts a turn
    expect(turns[0]!.stdin).toMatch(/^\[服務端現況摘要/);
    expect(turns[0]!.stdin).toContain('# 現況摘要');
    expect(turns[0]!.stdin).toContain('列出目前的任務狀態');
    expect(turns[1]!.stdin).toMatch(/^\[訊息｜來源 cli｜m_\d+\]\n\/clear$/);

    // `team` resolves to a shim that runs this repo's CLI as the leader actor; no token inside
    const shim = join(h.dataDir, 'leader', 'bin', 'team');
    const text = readFileSync(shim, 'utf8');
    expect(text).toContain('AGENT_TEAM_ACTOR=leader');
    expect(text).toContain(`AGENT_TEAM_HOME='${h.dataDir}'`);
    expect(text).toContain('team-bin.js');
    expect(text).not.toMatch(/token|Bearer|PASSWORD/i);
    expect(statSync(shim).mode & 0o777).toBe(0o700);

    // replies are outgoing messages that refer to their input, with a leader.reply event
    const inbound = h.store.messages.findByClientMsgId('leader', 'c-1')!;
    expect(inbound.status).toBe('delivered');
    const reply = h.store.messages.findByClientMsgId('leader', `reply:${inbound.id}`)!;
    expect(reply).toMatchObject({ direction: 'out', source: 'service', ref: inbound.id });
    const events = h.store.events.listAfter(0).filter((e) => e.type === 'leader.reply');
    expect(events.map((e) => e.data)).toContainEqual({
      message_id: reply.id,
      in_reply_to: inbound.id,
      channel: 'leader',
    });
    expect(h.service.leader.status()).toMatchObject({
      state: 'idle',
      available: true,
      context_tokens: 1200,
      quota: { utilization: 0.25, exhausted: false },
    });
  });

  it('runs one turn at a time; human messages before the event digest; events coalesce', async () => {
    await start(
      (c) => {
        c.leader.event_window_ms = 100;
      },
      turnSteps({ delayMs: 300 }),
    );
    const a = send('第一則', 'c-a');
    await until(() => fake.turns().length === 1);
    const { engine } = h.service;
    const q1 = engine.openAttention({ question: '用哪個？', options: ['甲', '乙'] });
    const q2 = engine.openAttention({ question: '要不要？', options: ['要', '不要'] });
    engine.answerAttention(q1.id, '甲', 'web');
    engine.answerAttention(q2.id, '不要', 'mcp');
    const b = send('第二則', 'c-b');
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    await until(() => fake.turns().length === 3);
    await leader().settled();

    const stdin = fake.turns().map((t) => t.stdin);
    expect(stdin).toHaveLength(3);
    expect(stdin[0]).toContain('第一則');
    expect(stdin[1]).toContain('第二則');
    expect(stdin[2]).toMatch(/^\[服務端事件摘要｜seq \d+–\d+/);
    expect(stdin[2]).toContain(`待決事項 \`${q1.id}\` 已回答（web）：甲`);
    expect(stdin[2]).toContain(`待決事項 \`${q2.id}\` 已回答（mcp）：不要`);
    // the digest is stored as a service message with its reply; the cursor moved past it
    const digest = h.store.messages
      .list()
      .find((m) => m.source === 'service' && m.direction === 'in')!;
    expect(digest.body).toBe(stdin[2]!.trim());
    expect(h.store.messages.findByClientMsgId('leader', `reply:${digest.id}`)).toBeDefined();
    const answered = h.store.events.listAfter(0).findLast((e) => e.type === 'attention.answered')!;
    expect(Number(h.store.kv.get(LEADER_EVENT_CURSOR_KEY))).toBe(answered.seq);
  });

  it('ignores its own actions: attention answered by the leader does not start a turn', async () => {
    await start((c) => {
      c.leader.event_window_ms = 20;
    });
    const q = h.service.engine.openAttention({ question: 'Q?', options: ['A'] });
    const res = await h
      .localApp()
      .request(
        `/api/attention/${q.id}/answer`,
        local({ answer: 'A', via: 'cli' }, { 'X-Team-Actor': 'leader' }),
      );
    expect(((await res.json()) as Loose).attention.answered_via).toBe('leader');
    await new Promise((r) => setTimeout(r, 80));
    await leader().settled();
    expect(fake.turns()).toEqual([]);
  });

  it('a duplicate client_msg_id returns the stored reply (also while in flight)', async () => {
    await start(undefined, turnSteps({ text: '收到', delayMs: 200 }));
    const [x, y] = await Promise.all([send('哈囉', 'dup-1'), send('哈囉', 'dup-1')]);
    expect(x.body.reply).toBe('收到');
    expect(y.body.reply).toBe('收到');
    const again = await send('哈囉', 'dup-1');
    expect(again.body).toEqual(x.body);
    expect(fake.turns()).toHaveLength(1);
    expect(h.store.messages.list({ channel: 'leader' })).toHaveLength(2);
  });

  it('compacts above the threshold before the next input, then re-briefs', async () => {
    await start(
      (c) => {
        c.leader.compact_threshold_tokens = 5000;
      },
      turnSteps({ contextTokens: 8000 }),
    );
    await send('一', 'k-1');
    expect(h.service.leader.status().context_tokens).toBe(8000);
    // the compaction turn and the next turn play the same scenario: boundary + a normal answer
    await fake.set([...compactSteps(8000, 900).slice(0, 3), ...turnSteps({ contextTokens: 1500 })]);
    await send('二', 'k-2');
    const turns = fake.turns();
    expect(turns.map((t) => (t.stdin.startsWith('/compact') ? '/compact' : 'turn'))).toEqual([
      'turn',
      '/compact',
      'turn',
    ]);
    expect(turns[1]!.stdin).toBe('/compact');
    expect(turns[1]!.argv).toContain('--resume');
    expect(turns[2]!.stdin).toMatch(/^\[服務端現況摘要/);
    expect(turns[2]!.stdin).toContain('二');
    expect(h.service.leader.status().context_tokens).toBe(1500);
  });

  it('answers stored messages that never got a reply after a restart', async () => {
    ({ h, fake } = bootLeader());
    await fake.set(turnSteps({ text: '補回覆' }));
    const { message } = h.service.engine.recordMessage({
      channel: 'leader',
      direction: 'in',
      source: 'web',
      body: '昨天的訊息',
      client_msg_id: 'old-1',
    });
    await h.service.start();
    await until(() => fake.turns().length === 1);
    await leader().settled();
    expect(h.store.messages.findByClientMsgId('leader', `reply:${message.id}`)?.body).toBe(
      '補回覆',
    );
  });
});
