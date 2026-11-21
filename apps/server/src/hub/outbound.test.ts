import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@agent-team/core';
import { SequentialIdGen, testModelsConfig } from '@agent-team/core/testing';
import type { Message, ServiceConfig } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvReader } from '../env.js';
import { createService, type Service } from '../service.js';
import { FakeGrok } from '../testing/fake-grokmsg.js';
import { createTestService, type TestService } from '../testing/harness.js';
import { enqueueOutbox } from './outbox.js';
import type { Summarize } from './summarizer.js';

// spec §10 出：outbox first, then the effect; per-lane order; signature de-dup also after a
// restart; attention question/options verbatim; routine progress merged per window and held in
// quiet hours (attention and quota never); long texts condensed, else 「（未整理）」.

let h: TestService | undefined;
let second: Service | undefined;
let dir: string | undefined;

afterEach(async () => {
  await second?.stop();
  second = undefined;
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

function boot(opts: { configure?: (c: ServiceConfig) => void; summarize?: Summarize } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'team-hub-out-'));
  const grok = new FakeGrok(dir);
  h = createTestService({
    configure: (c) => {
      c.grok.enabled = true;
      opts.configure?.(c);
    },
    hub: { command: [grok.exe], sourceEnv: grok.env(), watchBackoffMs: [20, 50] },
    ...(opts.summarize ? { summarize: opts.summarize } : {}),
  });
  return { h, grok };
}

const notices = (grok: FakeGrok) =>
  grok.records('notify').map((r) => r.file ?? r.argv[r.argv.indexOf('--text') + 1]);

/** A stored inbound Grok message and a leader reply to it, through the hub's reply hook. */
function leaderReplied(t: TestService, grokId: string, body: string): void {
  const { message } = t.service.engine.recordMessage({
    channel: 'grok',
    direction: 'in',
    source: 'grok',
    body: '問題',
    client_msg_id: grokId,
  });
  const reply: Message = { ...message, id: 'm_900001', direction: 'out', body, ref: message.id };
  t.service.engine.ctx.transact((tx) => t.service.hub.onLeaderReply(tx, message, reply));
}

describe('§10 hub outbound (fake grokmsg)', () => {
  it('keeps order within a lane and never sends a signature twice, also after a restart', async () => {
    const { h: t, grok } = boot();
    grok.configure({ notifyFail: true });
    await t.service.start();
    const until1 = '2026-11-21T05:00:00.000Z';
    t.service.engine.ctx.transact((tx) => t.service.hub.onLeaderRateLimited(tx, until1));
    t.service.engine.openAttention({ question: '第一題', options: ['甲'] });
    t.service.engine.openAttention({ question: '第二題', options: ['乙'] });
    await until(() => grok.records('notify').length === 1);
    await t.service.stop(); // the first delivery failed: everything is still pending

    grok.configure({});
    second = createService({
      store: t.store,
      runners: t.registry,
      git: t.git,
      checks: t.checks,
      clock: t.clock,
      ids: new SequentialIdGen(500_000),
      config: {
        service: t.config,
        models: testModelsConfig(),
        dataDir: t.dataDir,
        worktreeRoot: join(t.root, 'worktrees'),
        webDist: undefined,
      },
      env: createEnvReader({ file: join(t.root, 'test.env'), processEnv: {} }),
      logger: noopLogger,
      print: () => {},
      hub: { command: [grok.exe], sourceEnv: grok.env(), watchBackoffMs: [20, 50] },
    });
    await second.start();
    t.clock.advance(60_000); // past the retry backoff of the failed attempt
    second.engine.wake();
    await until(() => t.store.outbox.list().every((o) => o.status === 'sent'));
    // the same signature again (e.g. the leader hit the same limit): nothing new is queued
    second.engine.ctx.transact((tx) => second!.hub.onLeaderRateLimited(tx, until1));
    await second.engine.drain();
    expect(t.store.outbox.list()).toHaveLength(3);
    expect(notices(grok)).toEqual([
      `leader 額度用完，預計 ${until1} 恢復；訊息會保留，恢復後依序回覆`, // failed attempt
      `leader 額度用完，預計 ${until1} 恢復；訊息會保留，恢復後依序回覆`,
      '需要你決定：第一題\n選項：\n- 甲\n（回覆其中一個選項的原文）',
      '需要你決定：第二題\n選項：\n- 乙\n（回覆其中一個選項的原文）',
    ]);
  });

  it('merges routine progress per window; attention and quota go out at once', async () => {
    const { h: t, grok } = boot({ configure: (c) => void (c.grok.coalesce_window_ms = 60_000) });
    await t.service.start();
    const e = t.service.engine;
    e.ctx.transact((tx) => {
      for (const n of [1, 2, 3]) {
        enqueueOutbox(e, tx, {
          kind: 'task_done',
          signature: `task_done:t_${n}`,
          body: `任務完成：功能 ${n}（t_00000${n}）`,
          task_id: null,
        });
      }
    });
    e.openAttention({ question: '要不要合併？', options: ['要', '不要'] });
    e.ctx.transact((tx) => t.service.hub.onLeaderRateLimited(tx, '2026-11-21T06:00:00.000Z'));
    await until(() => grok.records('notify').length === 2);
    await e.drain();
    expect(notices(grok)[0]).toMatch(/^需要你決定：要不要合併？/);
    expect(notices(grok)[1]).toMatch(/^leader 額度用完/);
    t.service.hub.flushDue(); // window not over: nothing yet
    await e.drain();
    expect(grok.records('notify')).toHaveLength(2);

    t.clock.advance(61_000);
    t.service.hub.flushDue();
    await until(() => grok.records('notify').length === 3);
    expect(notices(grok)[2]).toBe(
      [
        '任務完成（3 則）',
        '- 任務完成：功能 1（t_000001）',
        '- 任務完成：功能 2（t_000002）',
        '- 任務完成：功能 3（t_000003）',
      ].join('\n'),
    );
    await until(() => t.store.outbox.list().every((o) => o.status === 'sent'));
    expect(t.store.outbox.list().filter((o) => o.signature.startsWith('digest:'))).toHaveLength(1);
  });

  it('holds routine progress during quiet hours; attention ignores them', async () => {
    const local = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const { h: t, grok } = boot({
      configure: (c) => {
        const now = new Date('2026-11-21T00:00:00.000Z');
        c.grok.coalesce_window_ms = 1000;
        c.grok.quiet_hours = {
          start: local(new Date(now.getTime() - 3_600_000)),
          end: local(new Date(now.getTime() + 2 * 3_600_000)),
        };
      },
    });
    await t.service.start();
    const e = t.service.engine;
    e.ctx.transact((tx) =>
      enqueueOutbox(e, tx, {
        kind: 'task_failed',
        signature: 'f:1',
        body: '任務失敗：甲',
        task_id: null,
      }),
    );
    e.openAttention({ question: '夜裡也要問', options: ['好'] });
    await until(() => grok.records('notify').length === 1);
    t.clock.advance(5_000);
    t.service.hub.flushDue();
    await e.drain();
    expect(notices(grok)).toEqual([
      '需要你決定：夜裡也要問\n選項：\n- 好\n（回覆其中一個選項的原文）',
    ]);
    t.clock.advance(3 * 3_600_000);
    t.service.hub.flushDue();
    await until(() => grok.records('notify').length === 2);
    expect(notices(grok)[1]).toBe('任務失敗：甲');
  });

  it('a notice stored without a webhook counts as delivered (no retries holding the lane)', async () => {
    const { h: t, grok } = boot();
    grok.configure({ webhookNotSet: true });
    await t.service.start();
    t.service.engine.openAttention({ question: '沒有 webhook 也要記錄', options: [] });
    await until(() => t.store.outbox.list().every((o) => o.status === 'sent'));
    expect(grok.records('notify')).toHaveLength(1);
    expect(t.store.effects.list()).toEqual([]);
  });

  it('passes long text through a private temp --file that is removed afterwards', async () => {
    const { h: t, grok } = boot();
    await t.service.start();
    const question = `請確認這段需求：${'很長的說明，'.repeat(200)}`;
    t.service.engine.openAttention({ question, options: ['確認'] });
    await until(() => grok.records('notify').length === 1);
    const [record] = grok.records('notify');
    expect(record!.argv).toContain('--file');
    expect(record!.argv).not.toContain('--text');
    expect(record!.file).toBe(
      `需要你決定：${question}\n選項：\n- 確認\n（回覆其中一個選項的原文）`,
    );
    expect(record!.fileMode).toBe('600');
    await until(() => t.store.outbox.list().every((o) => o.status === 'sent'));
    expect(existsSync(record!.argv[record!.argv.indexOf('--file') + 1]!)).toBe(false);
  });

  it('condenses a long leader reply; failure sends the truncated original marked （未整理）', async () => {
    const calls: string[] = [];
    let fail = false;
    const { h: t, grok } = boot({
      configure: (c) => {
        c.grok.summarize_threshold_chars = 50;
        c.grok.summary_max_chars = 40;
      },
      summarize: async (text, max) => {
        calls.push(`${max}:${text.slice(0, 4)}`);
        if (fail) throw new Error('model down');
        return '完成 3 項，1 項阻塞：缺少金鑰，下一步請補上。這句話會被截斷因為它超過上限很多很多字';
      },
    });
    await t.service.start();
    const long = `報告：${'細節'.repeat(60)}`;
    leaderReplied(t, 'g-long', long);
    await until(() => grok.records('reply').length === 1);
    const [first] = grok.records('reply');
    const text = first!.argv[first!.argv.indexOf('--text') + 1]!;
    expect(first!.argv.slice(0, 4)).toEqual(['reply', 'g-long', '--status', 'done']);
    expect([...text]).toHaveLength(40);
    expect(text.startsWith('完成 3 項，1 項阻塞')).toBe(true);

    fail = true;
    leaderReplied(t, 'g-fail', long);
    await until(() => grok.records('reply').length === 2);
    const failed = grok.records('reply')[1]!;
    const sent = failed.argv[failed.argv.indexOf('--text') + 1]!;
    expect(sent.endsWith('（未整理）')).toBe(true);
    expect([...sent]).toHaveLength(40);
    expect(sent.startsWith('報告：細節')).toBe(true);

    leaderReplied(t, 'g-short', '好的，已排入。');
    await until(() => grok.records('reply').length === 3);
    expect(grok.records('reply')[2]!.argv).toEqual([
      'reply',
      'g-short',
      '--status',
      'done',
      '--text',
      '好的，已排入。',
    ]);
    expect(calls).toEqual(['40:報告：細', '40:報告：細']); // the short one never reached the model
  });
});
