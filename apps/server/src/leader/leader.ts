import { randomUUID } from 'node:crypto';
import { errorMessage, TeamError, type Tx } from '@agent-team/core';
import type { ClaudeTextResult } from '@agent-team/runners';
import type { Message } from '@agent-team/schema';
import {
  freshConversation,
  loadConversation,
  saveConversation,
  type ConversationState,
  type Unavailable,
} from './conversation.js';
import { isLeaderRelevant } from './digest.js';
import { EventBuffer } from './event-buffer.js';
import {
  AUTH_HINT,
  classifyFailure,
  clip,
  composePrompt,
  logTurn,
  newPending,
  renewPending,
  type Composed,
  type Input,
  type Pending,
} from './inputs.js';
import { markDelivered, persistReply, storedAnswer, unansweredMessages } from './persist.js';
import { clearStarted, inputKey, markStarted, turnSeed, wasStarted } from './replay.js';
import { LeaderProcess, leaderModel } from './process.js';
import { leaderPromptVersion } from './prompt/system-v4.js';
import { resumeBrief } from './resume.js';
import {
  leaderStatus,
  StatusEvents,
  unavailableError as unavailable,
  whyUnavailable,
  type Offline,
  type StatusInputs,
} from './status.js';
import {
  LEADER_EVENT_CURSOR_KEY,
  LEADER_RECEIPTS_CURSOR_KEY,
  type LeaderDeps,
  type LeaderImpl,
} from './types.js';

export type { LeaderImpl } from './types.js';

// The Team Leader (spec §9): one headless Claude conversation, one `claude -p` per input, one
// turn at a time; humans first, engine events within `event_window_ms` as one digest. Compaction
// above the threshold, the resume brief after it; rate limits/login keep inputs queued.

interface Running {
  input: Input;
  abort: AbortController;
  /** Set when the turn is aborted on purpose. */
  stop?: 'reset' | 'stop';
  done: Promise<void>;
}

export function createLeader(deps: LeaderDeps): LeaderImpl {
  const { engine, store, clock, logger, service } = deps;
  const runtime = deps.runtime ?? { enabled: false };
  const mode = service.research.mode;
  const proc = runtime.enabled ? new LeaderProcess(runtime, deps.dataDir, mode) : undefined;
  const promptVersion = leaderPromptVersion(mode);

  let conv: ConversationState = freshConversation(randomUUID(), promptVersion);
  let offline: Offline | undefined = proc
    ? undefined
    : {
        reason: 'disabled',
        hint: 'the leader is off (service.json leader.enabled = false); messages are stored',
      };
  const humans: Pending[] = [];
  const byMessage = new Map<string, Pending>();
  const buffer = new EventBuffer(service.leader.event_window_ms, {
    maxWaitMs: service.leader.event_max_wait_ms,
    maxBatch: service.leader.digest_max_events,
  });
  let running: Running | undefined;
  let started = false;
  let stopped = false;
  let lastActivity: string | null = null;
  let recoveries = 0;
  let pumpQueued = false;
  const timers: { events?: NodeJS.Timeout | undefined; retry?: NodeJS.Timeout | undefined } = {};
  const statusEvents = new StatusEvents();

  const save = () => saveConversation(store.kv, conv);
  const nowIso = () => clock.now().toISOString();

  const inputs = (): StatusInputs => ({
    offline,
    started,
    conv,
    running: running !== undefined,
    queued: humans.length + (buffer.size > 0 ? 1 : 0),
    lastActivity,
  });
  const unavailability = () => whyUnavailable(inputs());
  const unavailableError = () => unavailable(unavailability());

  /** `leader.status_changed` in `tx` when the status differs from the last one emitted. */
  function emitStatus(tx: Tx): void {
    const now = leaderStatus(inputs());
    if (statusEvents.changed(now)) statusEvents.emit(tx, now);
  }

  /** Emit a status change (busy ↔ idle) in its own transaction, if there is one. */
  function syncStatus(): void {
    if (!started || stopped || !statusEvents.changed(leaderStatus(inputs()))) return;
    engine.ctx.transact(emitStatus);
  }

  /** Reject everyone waiting for a queued message; the messages stay queued. */
  function rejectWaiters(err: Error): void {
    for (const pending of humans) renewPending(pending, err);
  }

  function setUnavailable(next: Unavailable): void {
    conv.unavailable = next;
    save();
    engine.ctx.transact((tx) => {
      emitStatus(tx);
      if (next.reason === 'rate_limit' && next.until) deps.onRateLimited?.(tx, next.until);
    });
    logger.warn('leader unavailable', { reason: next.reason, until: next.until });
    rejectWaiters(unavailableError());
  }

  function clearUnavailable(): void {
    if (conv.unavailable === null) return;
    conv.unavailable = null;
    save();
    engine.ctx.transact(emitStatus);
    logger.info('leader available again');
  }

  function schedule(): void {
    if (pumpQueued) return;
    pumpQueued = true;
    setImmediate(() => {
      pumpQueued = false;
      pump();
      syncStatus();
    });
  }

  function arm(name: 'events' | 'retry', ms: number): void {
    if (timers[name]) return;
    timers[name] = setTimeout(
      () => {
        timers[name] = undefined;
        pump();
        syncStatus();
      },
      Math.max(0, Math.min(ms, 2 ** 31 - 1)),
    );
  }

  /** True while turns cannot run (re-checks a rate limit against the clock). */
  function blocked(): boolean {
    const u = conv.unavailable;
    if (!u) return false;
    if (u.reason === 'rate_limit' && u.until !== null) {
      const wait = Date.parse(u.until) - clock.now().getTime();
      if (wait <= 0) {
        clearUnavailable();
        return false;
      }
      arm('retry', wait);
    }
    return true;
  }

  function pump(): void {
    if (!started || stopped || running || offline || blocked()) return;
    let next: 'human' | 'events' | undefined;
    if (humans[0]) next = 'human';
    else if (buffer.size > 0) {
      const wait = buffer.waitMs();
      if (wait > 0) return arm('events', wait);
      next = 'events';
    }
    if (!next) return;
    if (conv.needs_compact) return run({ kind: 'compact' });
    run(
      next === 'human'
        ? { kind: 'human', pending: humans.shift()! }
        : { kind: 'events', events: buffer.take() },
    );
  }

  function requeue(input: Input): void {
    if (input.kind === 'human') humans.unshift(input.pending);
    else if (input.kind === 'events') buffer.putBack(input.events);
  }

  function newSession(): void {
    conv = freshConversation(randomUUID(), promptVersion, { quota: conv.quota });
    save();
  }

  const compose = (input: Input, replay: boolean): Composed =>
    composePrompt(input, {
      brief: conv.needs_brief,
      resumeBrief: () => resumeBrief(deps),
      store,
      replay,
    });

  function run(input: Input): void {
    const abort = new AbortController();
    const entry: Running = { input, abort, done: Promise.resolve() };
    running = entry;
    entry.done = turn(entry)
      .catch((err: unknown) => {
        logger.error('leader turn failed', { error: errorMessage(err) });
        if (input.kind === 'human')
          input.pending.reject(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (running === entry) running = undefined;
        if (input.kind === 'human' && !humans.includes(input.pending)) {
          byMessage.delete(input.pending.message.id);
        }
        schedule();
      });
  }

  async function turn(entry: Running): Promise<void> {
    const { input } = entry;
    const model = leaderModel(deps.models, engine.quotaState(), clock.now());
    if (!model) return failed(input, 'no claude model configured for role leader');
    // a marked input already had a turn that may have acted (crash, stop, reset): say so
    const key = inputKey(input);
    const { prompt, brief, digest } = compose(
      input,
      key !== undefined && wasStarted(store.kv, key),
    );
    if (key !== undefined) markStarted(store.kv, key, nowIso());
    const sessionId = conv.session_id;
    const result = await proc!.turn({
      prompt,
      sessionId,
      resume: conv.started,
      model,
      timeoutMs: service.leader.turn_timeout_ms,
      signal: entry.abort.signal,
      turnKey: key === undefined ? undefined : turnSeed(key),
    });
    lastActivity = nowIso();
    if (conv.session_id !== sessionId) {
      // reset while it ran: a finished answer still counts, anything else runs again
      if (result.error || input.kind === 'compact') return requeue(input);
      return deliver(input, result, false, digest);
    }
    if (result.quota) {
      conv.quota = {
        utilization: result.quota.utilization ?? null,
        resets_at: result.quota.resetsAt ?? null,
        exhausted: result.quota.exhausted ?? false,
      };
    }
    if (result.started) conv.started = true;
    logTurn(logger, input, model.alias, result);
    if (result.error) return onError(entry, result);
    recoveries = 0;
    if (input.kind === 'compact') {
      conv.needs_compact = false;
      conv.needs_brief = true;
      conv.context_tokens = result.compacted?.postTokens ?? null;
      save();
      return;
    }
    if (result.contextTokens !== undefined) conv.context_tokens = result.contextTokens;
    if (brief) conv.needs_brief = false;
    conv.needs_compact = (conv.context_tokens ?? 0) > service.leader.compact_threshold_tokens;
    save();
    deliver(input, result, brief, digest);
  }

  /** Store the reply of a finished human or digest turn and answer the waiting caller. */
  function deliver(
    input: Input,
    result: ClaudeTextResult,
    brief: boolean,
    digest: { body: string; key: string } | undefined,
  ): void {
    if (input.kind === 'compact') return;
    const text = result.text?.trim() || '（leader 沒有回覆內容）';
    const replyInput =
      input.kind === 'human'
        ? ({ kind: 'message', inbound: input.pending.message } as const)
        : ({ kind: 'digest', body: digest!.body, key: digest!.key } as const);
    const { reply } = persistReply(engine, replyInput, text, (tx, inbound, out) => {
      clearStarted(tx.r.kv, inputKey(input));
      if (input.kind === 'events') {
        tx.r.kv.set(LEADER_EVENT_CURSOR_KEY, String(input.events.at(-1)?.seq ?? 0));
      }
      if (brief) tx.r.kv.set(LEADER_RECEIPTS_CURSOR_KEY, tx.now);
      deps.onReply?.(tx, inbound, out);
    });
    if (input.kind === 'human')
      input.pending.resolve({ reply: reply.body, reply_message_id: reply.id });
  }

  /** A failure that is not about availability: the input is consumed (never replayed). */
  function failed(input: Input, message: string): void {
    clearStarted(store.kv, inputKey(input));
    if (input.kind === 'compact') {
      logger.warn('leader compaction failed; starting a new session with the brief', { message });
      newSession();
      return;
    }
    if (input.kind === 'events') {
      store.kv.set(LEADER_EVENT_CURSOR_KEY, String(input.events.at(-1)?.seq ?? 0));
      logger.warn('leader digest turn failed; events dropped', { message });
      return;
    }
    engine.ctx.transact((tx) => markDelivered(tx, input.pending.message.id));
    input.pending.reject(
      new TeamError(
        'unavailable',
        `the leader could not answer: ${clip(message)}`,
        'send it again',
      ),
    );
  }

  function onError(entry: Running, result: ClaudeTextResult): void {
    const { input } = entry;
    const what = classifyFailure(result, {
      aborted: entry.stop !== undefined,
      started: conv.started,
      recoveries,
      now: clock.now(),
      cooldownMs: service.engine.rate_limit_cooldown_ms,
    });
    if (what.action === 'fail') {
      save();
      return failed(input, `${result.error!.kind}: ${result.error!.message}`);
    }
    requeue(input);
    // a turn that ran no command (its only tool is Bash) did nothing: no replay notice next time
    if (!result.started || result.commands.length === 0) clearStarted(store.kv, inputKey(input));
    if (what.action === 'unavailable') return setUnavailable(what.unavailable);
    if (what.newSession || what.markStarted) {
      recoveries += 1;
      logger.warn('leader session recovery', { new_session: what.newSession === true });
      if (what.newSession) newSession();
      else {
        conv.started = true;
        save();
      }
    }
  }

  /** Stored human messages that never got an answer (restart, rate limit) are queued again. */
  const replayStored = () => unansweredMessages(store).forEach((m) => enqueue(m));

  function enqueue(message: Message): Pending {
    const existing = byMessage.get(message.id);
    if (existing) return existing;
    const pending = newPending(message);
    byMessage.set(message.id, pending);
    humans.push(pending);
    schedule();
    return pending;
  }

  const answered = (message: Message, info: { duplicate: boolean }) =>
    storedAnswer(store, message, { ...info, inflight: byMessage.has(message.id) });

  const leader: LeaderImpl = {
    status: () => leaderStatus(inputs()),

    notify: (batch) => {
      if (!started || stopped || offline?.reason === 'disabled') return;
      buffer.add(batch, isLeaderRelevant);
      if (buffer.size > 0) schedule();
    },

    handleMessage: async (message, info) => {
      const done = answered(message, info);
      if (done) return done;
      const inflight = byMessage.get(message.id);
      if (inflight) {
        if (unavailability()) throw unavailableError();
        return inflight.promise;
      }
      if (offline || stopped) throw unavailableError();
      const pending = enqueue(message);
      if (unavailability()) throw unavailableError();
      return pending.promise;
    },

    submit: (message, info) => {
      const done = answered(message, info);
      if (done) return done;
      // queued (or answered after the next start / `team leader reset` when the leader is off)
      if (!byMessage.has(message.id) && !offline && !stopped) enqueue(message);
      return undefined;
    },

    resumeBrief: () => resumeBrief(deps),

    resetSession: async () => {
      newSession();
      recoveries = 0;
      if (offline?.reason === 'not_installed' && proc) {
        const prep = await proc.prepare();
        offline = prep.problem ? { reason: 'not_installed', hint: prep.problem } : undefined;
        if (!offline) replayStored();
      }
      engine.ctx.transact(emitStatus);
      logger.info('leader session reset');
      if (running) {
        running.stop = 'reset';
        running.abort.abort('leader reset');
      }
      schedule();
      return { session_id: conv.session_id };
    },

    start: async () => {
      const loaded = loadConversation(store.kv, promptVersion, randomUUID);
      conv = loaded.state;
      // a login problem is retried on every start; a rate limit keeps its reset time
      if (conv.unavailable?.reason === 'auth') conv.unavailable = null;
      save();
      if (!proc) {
        started = true;
        statusEvents.baseline(leaderStatus(inputs()));
        return;
      }
      const prep = await proc.prepare();
      if (prep.problem) {
        offline = { reason: 'not_installed', hint: prep.problem };
        logger.warn('leader not available', { problem: prep.problem });
      }
      const cursor = store.kv.get(LEADER_EVENT_CURSOR_KEY);
      const from = cursor === undefined ? store.events.lastSeq() : Number(cursor);
      if (cursor === undefined) store.kv.set(LEADER_EVENT_CURSOR_KEY, String(from));
      buffer.load(store.events.listAfter(from).filter(isLeaderRelevant), store.events.lastSeq());
      replayStored();
      started = true;
      statusEvents.baseline(leaderStatus(inputs()));
      if (!offline && prep.loggedIn === false) {
        setUnavailable({ reason: 'auth', until: null, hint: AUTH_HINT });
      }
      logger.info('leader started', {
        session_resumed: conv.started,
        queued: humans.length,
        pending_events: buffer.size,
        offline: offline?.reason ?? null,
      });
      schedule();
    },

    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const t of Object.values(timers)) if (t) clearTimeout(t);
      const current = running;
      if (current) {
        current.stop = 'stop';
        current.abort.abort('service stopping');
        await current.done;
      }
      rejectWaiters(
        new TeamError(
          'unavailable',
          'the service is stopping',
          'the message is kept and answered after restart',
        ),
      );
      if (started && !offline && buffer.size === 0 && humans.length === 0) {
        store.kv.set(LEADER_EVENT_CURSOR_KEY, String(buffer.seenSeq));
      }
    },

    pump: () => {
      pump();
      syncStatus();
    },

    settled: async () => {
      for (;;) {
        const runnable = !offline && !conv.unavailable && (humans.length > 0 || buffer.size > 0);
        if (!running && !pumpQueued && !runnable) return;
        await (running?.done ?? new Promise((r) => setTimeout(r, 5)));
      }
    },
  };
  return leader;
}
