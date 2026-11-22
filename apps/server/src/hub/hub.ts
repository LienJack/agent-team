import { errorMessage, type Engine } from '@agent-team/core';
import type { Attention, OutboxItem } from '@agent-team/schema';
import { insertMessage, markDelivered } from '../leader/persist.js';
import {
  bufferItem,
  digestBody,
  dueGroups,
  IMMEDIATE_KINDS,
  readBuffer,
  writeBuffer,
} from './coalesce.js';
import { boardNotice, buttonVerdict, refusalText } from './buttons.js';
import { Grokmsg, type GrokMessage, type ReplyStatus } from './grokmsg.js';
import { anchorKey, enqueueOutbox, metaKey, readMeta, sentKey, summaryKey } from './outbox.js';
import { condense } from './summarizer.js';
import type { Hub, HubDeps } from './types.js';

// The Grok hub (spec §10). In: `grokmsg watch` → `grokmsg read <id>` → the verbatim text stored
// as an incoming grok message (dedupe key = grokmsg id) → the leader; a pick in Grok (`choice=`)
// answers the attention item it belongs to. Out: outbox first, then the `outbox.send` effect
// calls `send()` here: replies (`grokmsg reply`), attention items (`--status waiting_user` with
// the question and options verbatim), proactive notices (`grokmsg notify`, routine kinds merged
// per window and held in quiet hours). Option buttons only for the single open, normal-risk item
// whose question and options fit whole; a Grok answer is checked the same way (buttons.ts).

const RECEIVED = '已收到，處理中';

function disabledHub(): Hub {
  return {
    delivering: false,
    onLeaderReply: () => {},
    onLeaderRateLimited: () => {},
    flushDue: () => {},
    start: async () => {},
    stop: async () => {},
    send: async () => {
      throw new Error('the Grok hub is disabled (service.json grok.enabled = false)');
    },
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The question with its options, verbatim, for a notice about an item that could carry buttons
 * but has no message to attach them to (a typed option is accepted like a pick).
 */
export function attentionNotice(item: Attention): string {
  if (item.options.length === 0) return `需要你決定：${item.question}`;
  return [
    `需要你決定：${item.question}`,
    '選項：',
    ...item.options.map((o) => `- ${o}`),
    '（回覆其中一個選項的原文）',
  ].join('\n');
}

export function createHub(deps: HubDeps): Hub {
  if (!deps.service.grok.enabled) return disabledHub();
  const { store, clock, logger } = deps;
  const cfg = deps.service.grok;
  const grok = new Grokmsg(deps.runtime);
  let watchAbort: AbortController | undefined;
  let watching: Promise<void> | undefined;
  let inbound: Promise<void> = Promise.resolve();
  let flushTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const engine = (): Engine => {
    const e = deps.engine?.();
    if (!e) throw new Error('the hub was used before the engine exists');
    return e;
  };

  /**
   * The attention item a Grok message answers (by the anchor it replies to, or question). A pick
   * (`choice`) also matches an anchored item that is no longer open, so it gets a clear reply.
   */
  function matchAttention(msg: GrokMessage): { item: Attention; answer: string } | undefined {
    const candidates: Attention[] = [];
    const anchored = msg.reply_to ? store.kv.get(anchorKey(msg.reply_to)) : undefined;
    const byAnchor = anchored ? store.attention.get(anchored) : undefined;
    if (byAnchor && (byAnchor.status === 'open' || msg.choice !== undefined)) {
      candidates.push(byAnchor);
    }
    if (msg.choice !== undefined && msg.question) {
      for (const a of store.attention.list({ statuses: ['open'] })) {
        if (a.question === msg.question && a.id !== byAnchor?.id) candidates.push(a);
      }
    }
    const answer = msg.choice ?? msg.text.trim();
    for (const item of candidates) {
      const fits =
        item.options.length === 0 ? msg.choice !== undefined : item.options.includes(answer);
      if (fits) return { item, answer };
    }
    return undefined;
  }

  async function handleInbound(id: string): Promise<void> {
    if (store.messages.findByClientMsgId('grok', id)) return; // a restarted watcher re-lists
    const msg = await grok.read(id);
    if (!msg) {
      logger.warn('grokmsg read failed; message skipped', { grok_id: id });
      return;
    }
    const e = engine();
    const target = matchAttention(msg);
    // checked again at answer time: still the single open item, not high risk, fits whole
    let refusal: string | undefined;
    if (target) {
      const open = store.attention.list({ statuses: ['open'] });
      const verdict = buttonVerdict(target.item, open, cfg.buttons);
      if (!verdict.ok) refusal = refusalText(target.item, verdict.why, open.length);
    }
    const message = e.ctx.transact((tx) => {
      if (tx.r.messages.findByClientMsgId('grok', id)) return undefined;
      const stored = insertMessage(e, tx, {
        channel: 'grok',
        direction: 'in',
        source: 'grok',
        body: msg.text,
        client_msg_id: id,
        ref: msg.reply_to ?? null,
        status: 'new',
      });
      if (!target) {
        enqueueOutbox(e, tx, {
          kind: 'reply',
          signature: `reply:${id}:working`,
          body: RECEIVED,
          task_id: null,
          meta: { reply_to: id, mode: 'working' },
        });
      }
      return stored;
    });
    if (!message) return;
    if (target) {
      let text: string;
      if (refusal !== undefined) {
        text = refusal;
      } else {
        try {
          e.answerAttention(target.item.id, target.answer, 'grok');
          text = `已記錄你的選擇：${target.answer}`;
        } catch (err) {
          text = `這個問題已經處理過了（${errorMessage(err)}）`;
        }
      }
      e.ctx.transact((tx) => {
        markDelivered(tx, message.id);
        enqueueOutbox(e, tx, {
          kind: 'reply',
          signature: `reply:${id}:ack`,
          body: text,
          task_id: null,
          meta: { reply_to: id, mode: 'ack' },
        });
      });
      return;
    }
    deps
      .leader?.()
      .handleMessage(message, { duplicate: false })
      .catch((err: unknown) => {
        logger.info('grok message waits for the leader', {
          message_id: message.id,
          reason: errorMessage(err),
        });
      });
  }

  /** The text to send: short ones as is, long ones condensed once (cached across retries). */
  async function prepared(item: OutboxItem): Promise<string> {
    const cached = store.kv.get(summaryKey(item.id));
    if (cached !== undefined) return cached;
    const { text } = await condense(item.body, {
      threshold: cfg.summarize_threshold_chars,
      maxChars: cfg.summary_max_chars,
      summarize: deps.summarize,
    });
    store.kv.set(summaryKey(item.id), text);
    return text;
  }

  function anchoredOpen(grokId: string): Attention | undefined {
    const id = store.kv.get(anchorKey(grokId));
    const item = id ? store.attention.get(id) : undefined;
    return item?.status === 'open' ? item : undefined;
  }

  function forget(item: OutboxItem): void {
    store.kv.delete(metaKey(item.id));
    store.kv.delete(summaryKey(item.id));
  }

  async function sendReply(item: OutboxItem): Promise<void> {
    const meta = readMeta(store.kv, item.id);
    if (!meta) {
      logger.warn('grok reply without routing; skipped', { outbox_id: item.id });
      return;
    }
    let status: ReplyStatus = meta.mode === 'working' ? 'working' : 'done';
    let text = item.body;
    let ask: { question: string; options: string[] } | undefined;
    if (meta.mode === 'final') {
      text = await prepared(item);
      // an attention item is waiting on this conversation: keep its buttons, if it may have them
      const open = anchoredOpen(meta.reply_to);
      const allOpen = store.attention.list({ statuses: ['open'] });
      if (open && buttonVerdict(open, allOpen, cfg.buttons).ok) {
        status = 'waiting_user';
        ask = { question: open.question, options: open.options };
      }
    }
    const result = await grok.reply(meta.reply_to, { status, text, ...ask });
    if (result.pushed === false && status !== 'working') {
      logger.warn('grokmsg stored the reply but did not push it (webhook)', {
        grok_id: meta.reply_to,
      });
    }
    forget(item);
  }

  async function sendAttention(item: OutboxItem): Promise<void> {
    const id = item.signature.startsWith('attention:') ? item.signature.slice(10) : undefined;
    const attention = id ? store.attention.get(id) : undefined;
    if (!attention || attention.status !== 'open') return; // answered meanwhile
    const open = store.attention.list({ statuses: ['open'] });
    const verdict = buttonVerdict(attention, open, cfg.buttons);
    if (!verdict.ok) {
      // no buttons: the question verbatim and where to answer it (board or CLI)
      const notice = await grok.notify(boardNotice(attention, verdict.why, open.length));
      // anchored anyway: a pick or option typed in reply gets a clear refusal, not the leader
      if (notice.id) store.kv.set(anchorKey(notice.id), attention.id);
      if (!notice.pushed) logger.warn('grokmsg notify was not pushed (webhook not set)');
      return;
    }
    const anchor = store.messages.list({ channel: 'grok' }).findLast((m) => m.direction === 'in');
    if (anchor) {
      // stored before the send: a crash right after it still links the pick to this item
      store.kv.set(anchorKey(anchor.client_msg_id), attention.id);
      // buttons need a Grok message to hang on: the latest conversation (question verbatim)
      await grok.reply(anchor.client_msg_id, {
        status: 'waiting_user',
        text: attention.question,
        question: attention.question,
        options: attention.options,
      });
      return;
    }
    const notice = await grok.notify(attentionNotice(attention));
    // the notice id exists only after the send: a crash between the send and this write leaves
    // the notice without an anchor (a pick is then matched by its question text, matchAttention)
    if (notice.id) store.kv.set(anchorKey(notice.id), attention.id);
    if (!notice.pushed) logger.warn('grokmsg notify was not pushed (webhook not set)');
  }

  function scheduleFlush(nextAt?: number): void {
    if (stopped) return;
    const at = nextAt ?? dueGroups(readBuffer(store.kv), clock.now(), cfg).nextAt;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (at === undefined) return;
    const delay = Math.max(50, Math.min(at - clock.now().getTime(), 2 ** 31 - 1));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      hub.flushDue();
    }, delay);
  }

  async function watchLoop(signal: AbortSignal): Promise<void> {
    const [first, cap] = deps.runtime?.watchBackoffMs ?? [1000, 60_000];
    let delay = first;
    while (!signal.aborted) {
      const began = Date.now();
      let exit: number | null = null;
      try {
        const result = await grok.watch((id) => {
          inbound = inbound
            .then(() => handleInbound(id))
            .catch((err: unknown) => {
              logger.warn('grok inbound failed', { grok_id: id, error: errorMessage(err) });
            });
        }, signal);
        exit = result.exitCode;
      } catch (err) {
        logger.warn('cannot start grokmsg watch', { error: errorMessage(err) });
      }
      if (signal.aborted) break;
      if (Date.now() - began > 60_000) delay = first;
      logger.warn('grokmsg watch exited; restarting', { exit_code: exit, in_ms: delay });
      await sleep(delay, signal);
      delay = Math.min(delay * 2, cap);
    }
  }

  /**
   * One outbox item, at most once per signature: the `outbox.send` effect runs again when the
   * service stops between a successful send and the outbox update, so the send is recorded
   * (`sentKey`) right after it and a repeat is skipped. A crash between the send and that record
   * can still repeat it once.
   */
  async function deliver(item: OutboxItem): Promise<void> {
    if (store.kv.get(sentKey(item.signature)) !== undefined) {
      logger.info('outbox item already sent; not sent again', { outbox_id: item.id });
      return;
    }
    await deliverOnce(item);
    store.kv.set(sentKey(item.signature), clock.now().toISOString());
  }

  async function deliverOnce(item: OutboxItem): Promise<void> {
    if (item.kind === 'reply') return sendReply(item);
    if (item.kind === 'attention') return sendAttention(item);
    if (IMMEDIATE_KINDS.has(item.kind) || item.signature.startsWith('digest:')) {
      const notice = await grok.notify(await prepared(item));
      if (!notice.pushed) logger.warn('grokmsg notify was not pushed (webhook not set)');
      forget(item);
      return;
    }
    // routine progress: accepted into the durable buffer, merged and sent by flushDue()
    bufferItem(store.kv, item, item.created_at);
    scheduleFlush();
  }

  const hub: Hub = {
    delivering: true,

    // the engine drains the effect lane itself once this resolves (core EffectExecutor)
    send: (item) => deliver(item),

    onLeaderReply: (tx, inboundMessage, reply) => {
      if (inboundMessage.channel !== 'grok') return;
      const id = inboundMessage.client_msg_id;
      enqueueOutbox(engine(), tx, {
        kind: 'reply',
        signature: `reply:${id}:final:${reply.id}`,
        body: reply.body,
        task_id: null,
        meta: { reply_to: id, mode: 'final' },
      });
    },

    onLeaderRateLimited: (tx, until) => {
      enqueueOutbox(engine(), tx, {
        kind: 'quota_exhausted',
        signature: `quota_exhausted:leader:${until}`,
        body: `leader 額度用完，預計 ${until} 恢復；訊息會保留，恢復後依序回覆`,
        task_id: null,
      });
    },

    flushDue: () => {
      const e = engine();
      const { due, nextAt } = dueGroups(readBuffer(store.kv), clock.now(), cfg);
      if (due.length > 0) {
        const ids = new Set(due.flatMap((g) => g.items.map((i) => i.id)));
        e.ctx.transact((tx) => {
          for (const group of due) {
            const single = group.items.length === 1 ? group.items[0]!.task_id : null;
            enqueueOutbox(e, tx, {
              kind: group.kind,
              signature: `digest:${group.kind}:${group.items[0]!.id}`,
              body: digestBody(group),
              task_id: single,
            });
          }
          writeBuffer(
            tx.r.kv,
            readBuffer(tx.r.kv).filter((b) => !ids.has(b.id)),
          );
        });
      }
      scheduleFlush(nextAt);
    },

    start: async () => {
      if (!grok.resolve()) {
        logger.warn('grok.enabled is true but grokmsg is not on PATH; outbox items will retry');
      }
      watchAbort = new AbortController();
      watching = watchLoop(watchAbort.signal);
      scheduleFlush();
    },

    stop: async () => {
      stopped = true;
      watchAbort?.abort();
      if (flushTimer) clearTimeout(flushTimer);
      await watching;
      await inbound;
    },
  };
  return hub;
}
