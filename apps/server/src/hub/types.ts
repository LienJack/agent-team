import type { Clock, Engine, Logger, Notifier, Store, Tx } from '@agent-team/core';
import type { Message, ServiceConfig } from '@agent-team/schema';
import type { Leader } from '../leader/types.js';
import type { GrokmsgRuntime } from './grokmsg.js';
import type { Summarize } from './summarizer.js';

/**
 * The Grok hub (spec §10), controlled by `service.json` `grok.enabled` (default off: the owner's
 * existing hub session watches the same inbox).
 *
 * - As the engine's `Notifier` it delivers one outbox item: resolve when sent (or accepted into
 *   the coalescing buffer), throw to retry with backoff.
 * - `delivering` decides whether the engine writes outbox notifications at all (engine config
 *   `notifications`); a disabled hub reports false.
 * - `start()` begins watching the inbox (`grokmsg watch` → read → store message → leader) and
 *   `stop()` ends it.
 */
export interface Hub extends Notifier {
  readonly delivering: boolean;
  /** Leader reply hook (runs in the reply's transaction): queue the Grok reply. */
  onLeaderReply(tx: Tx, inbound: Message, reply: Message): void;
  /** The leader hit its rate limit (in that transaction): notify, never coalesced. */
  onLeaderRateLimited(tx: Tx, until: string): void;
  /** Flush coalesced notifications that are due (also runs on a timer). */
  flushDue(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HubRuntime extends GrokmsgRuntime {
  /** Watcher restart backoff: first delay and cap (ms). Default 1 s → 60 s. */
  watchBackoffMs?: readonly [number, number];
}

export interface HubDeps {
  service: ServiceConfig;
  logger: Logger;
  store: Store;
  clock: Clock;
  /** Set once the engine exists (the hub records inbound messages through it). */
  engine?: () => Engine;
  /** Set once the leader exists (inbound messages are handed to it). */
  leader?: () => Leader;
  runtime?: HubRuntime;
  /** Condenses long texts (role `hub_summarizer`); omitted = truncate with 「（未整理）」. */
  summarize?: Summarize;
}
