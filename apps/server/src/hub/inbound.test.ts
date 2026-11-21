import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClaude, fakeTeamEntry, turnSteps } from '../testing/fake-claude.js';
import { FakeGrok, watchLine } from '../testing/fake-grokmsg.js';
import { createTestService, type TestService } from '../testing/harness.js';
import { parseWatchLine } from './grokmsg.js';

// spec §10 進：`grokmsg watch` → `grokmsg read <id>` → verbatim incoming message (dedupe key =
// grokmsg id) → leader; a `choice=` answers the attention item. A fake grokmsg only.

let h: TestService | undefined;
let dir: string | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function boot(grok: FakeGrok, opts: { claude?: FakeClaude } = {}): TestService {
  return createTestService({
    configure: (c) => {
      c.grok.enabled = true;
    },
    hub: { command: [grok.exe], sourceEnv: grok.env(), watchBackoffMs: [20, 50] },
    ...(opts.claude
      ? {
          leader: (root: string) => ({
            enabled: true,
            command: opts.claude!.command(),
            teamEntry: fakeTeamEntry(root),
            sourceEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root },
          }),
        }
      : {}),
  });
}

const m1 = {
  id: '20261121-010203-aaaaaa',
  from: 'grok',
  text: '幫我把登入頁的 bug 修掉，預算 $10 內',
};

describe('§10 hub inbound (fake grokmsg)', () => {
  it('parses only the id of a watch line (the preview may contain anything)', () => {
    expect(parseWatchLine(watchLine(m1, 'a :: b id=zzz'))).toBe(m1.id);
    expect(parseWatchLine(`GROKMSG id=x1 from=grok reply_to=r1 choice='A :: B' :: 選擇`)).toBe(
      'x1',
    );
    expect(parseWatchLine('something else')).toBeUndefined();
  });

  it('stores the verbatim text once, acks working, the leader answers, the reply goes out done', async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-hub-'));
    const grok = new FakeGrok(dir, { watchLines: [watchLine(m1)], messages: { [m1.id]: m1 } });
    const claude = new FakeClaude(join(dir, 'claude'));
    await claude.set(turnSteps({ text: '已排入 1 個任務' }));
    h = boot(grok, { claude });
    await h.service.start();

    await until(() => grok.records('reply').length === 2);
    const stored = h.store.messages.findByClientMsgId('grok', m1.id)!;
    expect(stored).toMatchObject({ direction: 'in', source: 'grok', body: m1.text });
    expect(grok.records('read').map((r) => r.argv)).toEqual([['read', m1.id]]);
    expect(grok.records('reply').map((r) => r.argv)).toEqual([
      ['reply', m1.id, '--status', 'working', '--text', '已收到，處理中'],
      ['reply', m1.id, '--status', 'done', '--text', '已排入 1 個任務'],
    ]);
    // the leader got the verbatim text as data (source grok)
    expect(claude.turns()[0]!.stdin).toContain(`[訊息｜來源 grok｜${stored.id}]\n${m1.text}`);
    // the fake (temp PATH / absolute path) ran, never the real grokmsg
    for (const r of grok.records()) {
      expect(r.exe).toBe(grok.exe);
      expect(r.home).toBe(grok.home);
    }
    await until(() => h!.store.outbox.list().every((o) => o.status === 'sent'));
    expect(h.store.outbox.list().map((o) => [o.kind, o.status])).toEqual([
      ['reply', 'sent'],
      ['reply', 'sent'],
    ]);
  });

  it('restarts the watcher with backoff; a re-listed message is not stored twice; choice= answers', async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-hub-'));
    const option = '先跑 3 條（上限 US$10）';
    const question = '要先跑幾條？';
    const grok = new FakeGrok(dir, {
      watchLines: [watchLine(m1)],
      watchExit: 0, // exits at once: the hub restarts it
      messages: { [m1.id]: m1 },
    });
    h = boot(grok);
    await h.service.start();
    await until(() => h!.store.messages.findByClientMsgId('grok', m1.id) !== undefined);

    // an attention item rides on the latest Grok conversation, question and options verbatim
    const item = h.service.engine.openAttention({ question, options: [option, '取消'] });
    await until(() => grok.records('reply').some((r) => r.argv.includes('waiting_user')));
    const ask = grok.records('reply').find((r) => r.argv.includes('waiting_user'))!;
    expect(ask.argv).toEqual([
      'reply',
      m1.id,
      '--status',
      'waiting_user',
      '--question',
      question,
      '--option',
      option,
      '--option',
      '取消',
      '--text',
      question,
    ]);

    // the user picks in Grok: a new message with reply_to + choice (read gives the fields)
    const pick = {
      id: '20261121-010500-bbbbbb',
      from: 'grok',
      text: `選擇：${option}`,
      reply_to: m1.id,
      choice: option,
      question,
    };
    grok.configure({
      watchLines: [watchLine(m1), watchLine(pick)],
      watchExit: 0,
      messages: { [m1.id]: m1, [pick.id]: pick },
    });
    await until(() => h!.store.attention.get(item.id)?.status === 'answered');
    expect(h.store.attention.get(item.id)).toMatchObject({ answer: option, answered_via: 'grok' });
    await until(() => grok.records('reply').some((r) => r.argv[1] === pick.id));
    expect(grok.records('reply').find((r) => r.argv[1] === pick.id)!.argv).toEqual([
      'reply',
      pick.id,
      '--status',
      'done',
      '--text',
      `已記錄你的選擇：${option}`,
    ]);
    expect(grok.records('watch').length).toBeGreaterThanOrEqual(2);
    // each grokmsg id stored once, read once, however often the watcher re-listed it
    expect(
      h.store.messages.list({ channel: 'grok' }).filter((m) => m.direction === 'in'),
    ).toHaveLength(2);
    expect(grok.records('read').filter((r) => r.argv[1] === m1.id)).toHaveLength(1);
  });

  it('a disabled hub (default) spawns no process and writes no outbox rows', async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-hub-'));
    const grok = new FakeGrok(dir, { watchLines: [watchLine(m1)], messages: { [m1.id]: m1 } });
    h = createTestService({ hub: { command: [grok.exe], sourceEnv: grok.env() } });
    await h.service.start();
    h.service.engine.openAttention({ question: 'Q?', options: ['A'] });
    await h.service.engine.drain();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.service.hub.delivering).toBe(false);
    expect(grok.records()).toEqual([]);
    expect(h.store.outbox.list()).toEqual([]);
  });
});
