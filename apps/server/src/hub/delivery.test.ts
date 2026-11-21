import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGrok } from '../testing/fake-grokmsg.js';
import { createTestService, type TestService } from '../testing/harness.js';
import { anchorKey, enqueueOutbox, sentKey } from './outbox.js';

// Delivery order of one attention item (spec §10): the anchor (Grok message → attention id)
// is stored before `grokmsg reply` runs, so a crash right after the send still links the
// person's pick to the item; and a send that already succeeded is never repeated — the effect
// may run again when the service dies between the send and the outbox update.

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

function boot() {
  dir = mkdtempSync(join(tmpdir(), 'team-hub-delivery-'));
  const grok = new FakeGrok(dir);
  h = createTestService({
    configure: (c) => void (c.grok.enabled = true),
    hub: { command: [grok.exe], sourceEnv: grok.env(), watchBackoffMs: [20, 50] },
  });
  return { h, grok };
}

describe('§10 hub delivery: anchor first, never twice', () => {
  it('stores the anchor before the reply is sent (it survives a failed send)', async () => {
    const { h: t, grok } = boot();
    grok.configure({ replyFail: true });
    await t.service.start();
    t.service.engine.recordMessage({
      channel: 'grok',
      direction: 'in',
      source: 'grok',
      body: '要不要部署？',
      client_msg_id: 'g-anchor',
    });
    const item = t.service.engine.openAttention({ question: '部署嗎？', options: ['要', '不要'] });
    await until(() => grok.records('reply').length >= 1);
    expect(t.store.kv.get(anchorKey('g-anchor'))).toBe(item.id);
    expect(t.store.outbox.list().find((o) => o.kind === 'attention')?.status).toBe('pending');
  });

  it('does not send an outbox item again once it went out (same signature)', async () => {
    const { h: t, grok } = boot();
    await t.service.start();
    const e = t.service.engine;
    const notice = e.ctx.transact((tx) =>
      enqueueOutbox(e, tx, {
        kind: 'quota_exhausted',
        signature: 'quota_exhausted:codex:x',
        body: 'codex 額度用完',
        task_id: null,
      }),
    )!;
    await until(() => t.store.outbox.get(notice.id)?.status === 'sent');
    expect(t.store.kv.get(sentKey('quota_exhausted:codex:x'))).toBeDefined();
    // the effect runs again (e.g. the service died before the outbox row was updated)
    await t.service.hub.send(t.store.outbox.get(notice.id)!);
    await t.service.hub.send(t.store.outbox.get(notice.id)!);
    expect(grok.records('notify')).toHaveLength(1);

    t.service.engine.recordMessage({
      channel: 'grok',
      direction: 'in',
      source: 'grok',
      body: '問題',
      client_msg_id: 'g-twice',
    });
    e.openAttention({ question: '只問一次', options: ['好'] });
    await until(() => t.store.outbox.list().every((o) => o.status === 'sent'));
    const attention = t.store.outbox.list().find((o) => o.kind === 'attention')!;
    await t.service.hub.send(attention);
    expect(grok.records('reply')).toHaveLength(1);
  });
});
