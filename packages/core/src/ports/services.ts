import { newId, type EventRecord, type IdKind, type OutboxItem } from '@agent-team/schema';

/** Wall clock. The engine never reads time any other way (no Date.now / timers in core). */
export interface Clock {
  now(): Date;
}

/** Id source; production uses `newId` from schema, tests use sequential ids. */
export interface IdGen {
  newId(kind: IdKind): string;
}

/** Result of one machine check. */
export interface CheckOutcome {
  passed: boolean;
  /** Process exit code; null when killed (timeout/abort). */
  exitCode: number | null;
  /** Last lines of combined output (the engine keeps at most 20 for the fix ticket). */
  tail: string;
  durationMs: number;
}

/**
 * Runs one project check command (spec §6 step 4). Implemented in `packages/runners` (it shares
 * the subprocess utilities). Writes the full output to `logPath`; resolves with `passed: false`
 * for a failing command and rejects only for infrastructure errors (the effect is retried).
 * `cmd` comes from the owner's project config and runs in `cwd` with an allow-listed environment
 * (no credentials, no SSH agent, no listener token, `GIT_TERMINAL_PROMPT=0`). The command runs
 * worker-authored code (tests) unsandboxed as the service user (docs/adr/0014).
 */
export interface CheckExecutor {
  run(input: {
    cwd: string;
    name: string;
    cmd: string;
    logPath: string;
    timeoutMs: number;
    /** Abort (service shutdown): the check's process group is killed and the call rejects. */
    signal?: AbortSignal;
    /** Primary checkout of the project (its `.env` and git hooks are off limits to the check). */
    repoPath?: string;
  }): Promise<CheckOutcome>;
}

/**
 * Delivers one outbox item to its target (Grok: `grokmsg notify`). Called by the `outbox.send`
 * effect: resolve when delivered, throw to retry with backoff. Items with the same signature are
 * never enqueued twice, so implementations need not dedupe. Implemented in `apps/server` (hub).
 */
export interface Notifier {
  send(item: OutboxItem): Promise<void>;
}

/**
 * Receives committed events the leader should hear about (`LEADER_EVENT_TYPES`), after the
 * transaction commits. Must return quickly and never throw; the implementation (apps/server
 * leader) batches them into the leader conversation and keeps its own cursor in `kv` so nothing
 * is lost across restarts (events are durable in the event table).
 */
export interface LeaderNotifier {
  notify(events: readonly EventRecord[]): void;
}

/** Fan-out of every committed event (SSE live push). Must return quickly and never throw. */
export interface EventPublisher {
  publish(events: readonly EventRecord[]): void;
}

/** Structured log sink; core never writes to the console. Field values must not be secrets. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Production `IdGen`: random ids from `newId` (Web Crypto, no IO). */
export const randomIdGen: IdGen = { newId };
