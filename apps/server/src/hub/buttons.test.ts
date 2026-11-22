import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleAttention } from '@agent-team/core/testing';
import { defaultServiceConfig, type Attention, type Message } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGrok, watchLine } from '../testing/fake-grokmsg.js';
import { createTestService, type TestService } from '../testing/harness.js';
import { buttonVerdict } from './buttons.js';

// spec §10 option buttons (docs/adr/0022 §3): only for the single open, normal-risk item whose
// question and options fit whole; high-risk items are answered from the board or the CLI; a
// Grok answer is checked again when it arrives. A fake grokmsg only (never the real one).

const LIMITS = defaultServiceConfig().grok.buttons;

let h: TestService | undefined;
let dir: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const m1 = { id: '20261122-010203-aaaaaa', from: 'grok', text: '幫我看一下進度' };

function boot(): { t: TestService; grok: FakeGrok } {
  dir = mkdtempSync(join(tmpdir(), 'team-hub-buttons-'));
  // the watcher exits at once and is restarted: later picks are listed on the next start
  const grok = new FakeGrok(dir, {
    watchLines: [watchLine(m1)],
    watchExit: 0,
    messages: { [m1.id]: m1 },
  });
  h = createTestService({
    configure: (c) => {
      c.grok.enabled = true;
    },
    hub: { command: [grok.exe], sourceEnv: grok.env(), watchBackoffMs: [20, 50] },
  });
  return { t: h, grok };
}

const textOf = (argv: string[]) => argv[argv.indexOf('--text') + 1] ?? '';
const withButtons = (grok: FakeGrok) =>
  grok.records('reply').filter((r) => r.argv.includes('--option'));

/** A pick in Grok on the conversation `m1` (what `grokmsg read` returns for it). */
function pick(grok: FakeGrok, id: string, item: Attention, choice: string): void {
  const msg = {
    id,
    from: 'grok',
    text: `選擇：${choice}`,
    reply_to: m1.id,
    choice,
    question: item.question,
  };
  grok.configure({
    watchLines: [watchLine(m1), watchLine(msg)],
    watchExit: 0,
    messages: { [m1.id]: m1, [id]: msg },
  });
}

describe('buttonVerdict', () => {
  const item = sampleAttention({ id: 'a_000001', options: ['甲', '乙'] });
  it('allows buttons for the single open normal item that fits', () => {
    expect(buttonVerdict(item, [item], LIMITS)).toEqual({ ok: true });
  });
  it('refuses them otherwise, with the reason', () => {
    const other = sampleAttention({ id: 'a_000002' });
    expect(buttonVerdict(item, [item, other], LIMITS)).toEqual({ ok: false, why: 'several_open' });
    expect(buttonVerdict({ ...item, status: 'answered' }, [], LIMITS)).toMatchObject({
      why: 'not_open',
    });
    for (const topic of [
      'base_drift',
      'start_unknown',
      'worker_unconfirmed',
      'worktree_identity',
      'workspace_kept',
      'unclassified',
    ] as const) {
      const risky = { ...item, topic };
      expect(buttonVerdict(risky, [risky], LIMITS)).toMatchObject({ why: 'high_risk' });
    }
    const noOptions = { ...item, options: [] };
    expect(buttonVerdict(noOptions, [noOptions], LIMITS)).toMatchObject({ why: 'no_options' });
    const longLabel = { ...item, options: ['x'.repeat(LIMITS.option_max_chars + 1)] };
    expect(buttonVerdict(longLabel, [longLabel], LIMITS)).toMatchObject({ why: 'too_long' });
    const longQuestion = { ...item, question: 'q'.repeat(LIMITS.question_max_chars + 1) };
    expect(buttonVerdict(longQuestion, [longQuestion], LIMITS)).toMatchObject({ why: 'too_long' });
    const many = {
      ...item,
      options: ['1', '2', '3', '4', '5', '6'].slice(0, LIMITS.max_options + 1),
    };
    expect(buttonVerdict(many, [many], LIMITS)).toMatchObject({ why: 'too_long' });
    // exactly at the limits still fits
    const edge = {
      ...item,
      question: 'q'.repeat(LIMITS.question_max_chars),
      options: Array.from({ length: LIMITS.max_options }, (_, i) =>
        `${i}`.repeat(LIMITS.option_max_chars),
      ),
    };
    expect(buttonVerdict(edge, [edge], LIMITS)).toEqual({ ok: true });
  });
});

describe('§10 hub option buttons (fake grokmsg)', () => {
  it('a high-risk item gets no buttons and says where to answer; a Grok pick is refused', async () => {
    const { t, grok } = boot();
    await t.service.start();
    await until(() => t.store.messages.findByClientMsgId('grok', m1.id) !== undefined);
    const p = t.service.engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
    t.runners.dsh.script({ start: 'unknown' }); // → start_unknown: retry is high risk
    t.service.engine.createTask({
      project_id: p.id,
      title: '一張單',
      tier: 'C',
      ticket_md: '# x',
      owned_paths: ['src/a'],
      queue: true,
    });
    await until(() => t.store.attention.list({ statuses: ['open'] }).length === 1);
    const item = t.store.attention.list({ statuses: ['open'] })[0]!;
    expect(item.topic).toBe('start_unknown');
    await until(() => grok.records('notify').some((r) => textOf(r.argv).includes(item.id)));
    const notice = textOf(
      grok.records('notify').find((r) => textOf(r.argv).includes(item.id))!.argv,
    );
    expect(notice).toContain(`需要你決定：${item.question}`);
    expect(notice).toContain('只能在看板或 CLI 回答');
    expect(notice).toContain(`team attention answer ${item.id}`);
    expect(notice).not.toContain('回覆其中一個選項的原文');
    expect(withButtons(grok)).toEqual([]);

    pick(grok, '20261122-010300-bbbbbb', item, '重試');
    await until(() => grok.records('reply').some((r) => r.argv[1] === '20261122-010300-bbbbbb'));
    const reply = grok.records('reply').find((r) => r.argv[1] === '20261122-010300-bbbbbb')!;
    expect(textOf(reply.argv)).toMatch(/^沒有記錄這次的選擇：這個決定可能捨棄工作或略過安全檢查/);
    expect(t.store.attention.get(item.id)?.status).toBe('open');
    // the refused pick never reaches the leader as a message to act on
    const stored = t.store.messages.findByClientMsgId('grok', '20261122-010300-bbbbbb')!;
    expect(stored.status).toBe('delivered');
  });

  it('two open items: the second gets no buttons, and a pick on the first is refused', async () => {
    const { t, grok } = boot();
    await t.service.start();
    await until(() => t.store.messages.findByClientMsgId('grok', m1.id) !== undefined);
    const first = t.service.engine.openAttention({ question: '先做哪個？', options: ['甲', '乙'] });
    await until(() => withButtons(grok).length === 1);
    expect(withButtons(grok)[0]!.argv).toContain(first.question);
    const second = t.service.engine.openAttention({ question: '預算？', options: ['10', '20'] });
    await until(() => grok.records('notify').some((r) => textOf(r.argv).includes(second.id)));
    expect(textOf(grok.records('notify').at(-1)!.argv)).toContain('目前有 2 個待決事項');
    expect(withButtons(grok)).toHaveLength(1);

    pick(grok, '20261122-010400-cccccc', first, '甲');
    await until(() => grok.records('reply').some((r) => r.argv[1] === '20261122-010400-cccccc'));
    const reply = grok.records('reply').find((r) => r.argv[1] === '20261122-010400-cccccc')!;
    expect(textOf(reply.argv)).toContain('目前有 2 個待決事項，無法確定它對應哪一個');
    expect(t.store.attention.get(first.id)?.status).toBe('open');
  });

  it('an option too long for a button: no buttons, the full text and a pointer to the board/CLI', async () => {
    const { t, grok } = boot();
    await t.service.start();
    await until(() => t.store.messages.findByClientMsgId('grok', m1.id) !== undefined);
    const long = `先把整個登入流程重寫成新的 session 機制，再回頭處理${'細節'.repeat(20)}`;
    const item = t.service.engine.openAttention({
      question: '怎麼做？',
      options: [long, '先不做'],
    });
    await until(() => grok.records('notify').some((r) => textOf(r.argv).includes(item.id)));
    const notice = textOf(grok.records('notify').at(-1)!.argv);
    expect(notice).toContain(`- ${long}`); // never truncated
    expect(notice).toContain('請在看板或 CLI 回答');
    expect(withButtons(grok)).toEqual([]);
  });

  it("a leader reply keeps the conversation's buttons only while the item may have them", async () => {
    const { t, grok } = boot();
    await t.service.start();
    await until(() => t.store.messages.findByClientMsgId('grok', m1.id) !== undefined);
    const inbound = t.store.messages.findByClientMsgId('grok', m1.id)!;
    const item = t.service.engine.openAttention({
      question: '要合併嗎？',
      options: ['要', '不要'],
    });
    await until(() => withButtons(grok).length === 1);
    const replyTo = (n: number): Message => ({
      ...inbound,
      id: `m_90000${n}`,
      direction: 'out',
      body: `回覆 ${n}`,
      ref: inbound.id,
    });
    t.service.engine.ctx.transact((tx) => t.service.hub.onLeaderReply(tx, inbound, replyTo(1)));
    await until(() => grok.records('reply').some((r) => textOf(r.argv) === '回覆 1'));
    const one = grok.records('reply').find((r) => textOf(r.argv) === '回覆 1')!;
    expect(one.argv).toEqual(expect.arrayContaining(['waiting_user', '--question', item.question]));

    t.service.engine.openAttention({ question: '另一題', options: ['好'] });
    t.service.engine.ctx.transact((tx) => t.service.hub.onLeaderReply(tx, inbound, replyTo(2)));
    await until(() => grok.records('reply').some((r) => textOf(r.argv) === '回覆 2'));
    const two = grok.records('reply').find((r) => textOf(r.argv) === '回覆 2')!;
    expect(two.argv.slice(0, 4)).toEqual(['reply', m1.id, '--status', 'done']);
    expect(two.argv).not.toContain('--option');
  });
});
