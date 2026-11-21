import type { Clock, Engine, LeaderNotifier, Logger, Store, Tx } from '@agent-team/core';
import type { LeaderStatus, Message, ModelsConfig, ServiceConfig } from '@agent-team/schema';

/**
 * kv key holding the `ended_at` (ISO) up to which the leader has read run receipts; receipts of
 * runs that ended later are "unread" in `resumeBrief()`. Advanced after each successful turn.
 */
export const LEADER_RECEIPTS_CURSOR_KEY = 'leader:receipts_read_at';

/** kv key of the headless leader conversation's session id (spec §9). */
export const LEADER_SESSION_KEY = 'leader:session_id';

/** kv key of the rest of the conversation state (JSON, see `ConversationState`). */
export const LEADER_CONVERSATION_KEY = 'leader:conversation';

/** kv key: seq of the last engine event handed to the leader in a digest. */
export const LEADER_EVENT_CURSOR_KEY = 'leader:event_cursor';

export interface LeaderReply {
  /** Text shown to the human. */
  reply: string;
  /** The stored outgoing message, when the reply was persisted. */
  reply_message_id: string | null;
}

/**
 * The Team Leader (spec §9): one headless Claude conversation fed with human messages (any
 * entrance) and batched engine events, one turn at a time.
 *
 * - `handleMessage` is called after the message is stored (deduplicated by `client_msg_id`); it
 *   resolves with the reply, or throws a `TeamError` (`unavailable` while the leader cannot take
 *   turns — the message then stays queued and is answered later).
 * - `notify` receives committed events (the server feeds it every event); it returns quickly and
 *   never throws. The leader keeps its own cursor in `kv`, so nothing is lost across restarts.
 */
export interface Leader extends LeaderNotifier {
  status(): LeaderStatus;
  handleMessage(message: Message, info: { duplicate: boolean }): Promise<LeaderReply>;
  /** Model-free summary for a new conversation or a new login (GET /api/resume). */
  resumeBrief(): string;
  /** New conversation (new session id; the next turn starts with the resume brief). */
  resetSession(): Promise<{ session_id: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** How the leader runs its turns; `main.ts` supplies the real values, tests the fake CLI. */
export interface LeaderRuntime {
  /** false: no conversation in this process (fake runners, tests); messages are only stored. */
  enabled: boolean;
  /** argv prefix of the claude executable (default: `claude` on PATH). */
  command?: readonly string[];
  /** The `team` CLI entry script (`apps/cli/dist/bin.js`); the leader's `team` runs it. */
  teamEntry?: string;
  /** Node executable for the `team` shim (default: this process's). */
  nodePath?: string;
  /** Environment the child allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface LeaderDeps {
  engine: Engine;
  store: Store;
  clock: Clock;
  logger: Logger;
  models: ModelsConfig;
  service: ServiceConfig;
  /** Absolute DATA directory (the leader's cwd, `team` shim and turn log live under it). */
  dataDir: string;
  runtime?: LeaderRuntime;
  /** Runs inside the transaction that stores a reply (the hub queues the Grok reply). */
  onReply?: (tx: Tx, inbound: Message, reply: Message) => void;
  /** Runs inside the transaction that marks the leader rate limited (the hub notifies). */
  onRateLimited?: (tx: Tx, until: string) => void;
}
