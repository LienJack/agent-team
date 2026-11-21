import type { Clock, Engine, Logger, Notifier, Store } from '@agent-team/core';
import type { ServiceConfig } from '@agent-team/schema';

/**
 * The Grok hub (spec §10), controlled by `service.json` `grok.enabled` (default off).
 *
 * - As the engine's `Notifier` it delivers one outbox item (`grokmsg notify`): resolve when sent,
 *   throw to retry with backoff.
 * - `delivering` decides whether the engine writes outbox notifications at all (engine config
 *   `notifications`); a hub that cannot deliver must report false.
 * - `start()` begins watching the inbox (`grokmsg watch` → read → store message → leader) and
 *   `stop()` ends it. Phase 3 implements them.
 */
export interface Hub extends Notifier {
  readonly delivering: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HubDeps {
  service: ServiceConfig;
  logger: Logger;
  store: Store;
  clock: Clock;
  /** Set once the engine exists (the hub records inbound messages through it). */
  engine?: () => Engine;
}
