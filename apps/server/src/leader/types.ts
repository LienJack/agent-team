import type { Clock, Engine, LeaderNotifier, Logger, Store } from '@agent-team/core';
import type { LeaderStatus, Message, ModelsConfig, ServiceConfig } from '@agent-team/schema';

/**
 * kv key holding the `ended_at` (ISO) up to which the leader has read run receipts; receipts of
 * runs that ended later are "unread" in `resumeBrief()`. Phase 3 advances it after reporting.
 */
export const LEADER_RECEIPTS_CURSOR_KEY = 'leader:receipts_read_at';

/** kv key of the headless leader conversation's session id (spec §9). */
export const LEADER_SESSION_KEY = 'leader:session_id';

export interface LeaderReply {
  /** Text shown to the human. */
  reply: string;
  /** The stored outgoing message, when the reply was persisted. */
  reply_message_id: string | null;
}

/**
 * The Team Leader (spec §9): one headless Claude conversation fed with human messages (any
 * entrance) and batched engine events. Phase 2 ships a stub (`createLeader`); phase 3 replaces
 * it without touching the routes.
 *
 * - `handleMessage` is called after the message is stored (deduplicated by `client_msg_id`); it
 *   processes messages one at a time and resolves with the reply, or throws a `TeamError`
 *   (`unavailable` while no conversation is running).
 * - `notify` (LeaderNotifier) receives committed `LEADER_EVENT_TYPES` events; it must return
 *   quickly and never throw. Events are durable, so a restart resumes from a kv cursor.
 */
export interface Leader extends LeaderNotifier {
  status(): LeaderStatus;
  handleMessage(message: Message, info: { duplicate: boolean }): Promise<LeaderReply>;
  /** Model-free summary for a new conversation or a new login (GET /api/resume). */
  resumeBrief(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface LeaderDeps {
  engine: Engine;
  store: Store;
  clock: Clock;
  logger: Logger;
  models: ModelsConfig;
  service: ServiceConfig;
  /** Absolute DATA directory (session logs). */
  dataDir: string;
}
