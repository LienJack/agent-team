import {
  LEADER_EVENT_TYPES,
  type EngineSettings,
  type EventData,
  type EventRecord,
  type EventType,
  type ModelsConfig,
  type NewEvent,
} from '@agent-team/schema';
import type { GitPort } from '../ports/git.js';
import type { Repositories, Store } from '../ports/repositories.js';
import type { RunnerRegistry } from '../ports/runner.js';
import type {
  CheckExecutor,
  Clock,
  EventPublisher,
  IdGen,
  LeaderNotifier,
  Logger,
  Notifier,
} from '../ports/services.js';
import { noopLogger } from '../ports/services.js';

/** Static configuration of an engine instance (assembled by apps/server from the config files). */
export interface EngineConfig {
  models: ModelsConfig;
  /** `service.json` → `engine`. */
  engine: EngineSettings;
  /** Absolute data directory (`DATA`); run logs go to `DATA/runs/<run_id>`. */
  dataDir: string;
  /** Absolute worktree root (`~` already expanded). */
  worktreeRoot: string;
  /** Write outbox notifications (`service.json` → `grok.enabled`). */
  notifications: boolean;
}

/** Everything the engine talks to. Only ports — no IO happens in core itself. */
export interface EngineDeps {
  store: Store;
  runners: RunnerRegistry;
  git: GitPort;
  checks: CheckExecutor;
  clock: Clock;
  ids: IdGen;
  config: EngineConfig;
  notifier?: Notifier;
  leader?: LeaderNotifier;
  publisher?: EventPublisher;
  logger?: Logger;
}

type EventRefs = { task_id?: string | null; run_id?: string | null };

/** One open transaction: repositories plus event emission at a fixed timestamp. */
export class Tx {
  readonly emitted: EventRecord[] = [];
  /** Set when the transaction changed state or queued work (wakes the engine after commit). */
  dirty = false;

  constructor(
    readonly r: Repositories,
    readonly nowDate: Date,
  ) {}

  get now(): string {
    return this.nowDate.toISOString();
  }

  /** Append an event (spec §8: every state change writes one). */
  emit<T extends EventType>(type: T, data: EventData<T>, refs: EventRefs = {}): EventRecord {
    const event = {
      ts: this.now,
      type,
      data,
      task_id: refs.task_id ?? null,
      run_id: refs.run_id ?? null,
    } as NewEvent;
    const stored = this.r.events.append(event);
    this.emitted.push(stored);
    this.dirty = true;
    return stored;
  }
}

/** Shared mutable state of one engine instance, passed to the engine modules. */
export class EngineContext {
  readonly store: Store;
  readonly config: EngineConfig;
  readonly logger: Logger;
  /** Abort controllers of runs started by this process. */
  readonly inflight = new Map<string, AbortController>();
  /** Effect executions and dispatches in progress (awaited by `drain`). */
  readonly work = new Set<Promise<unknown>>();
  /** Completion handlers of runs in progress (awaited by `runUntilIdle`). */
  readonly runWork = new Set<Promise<unknown>>();
  /** Task ids currently being prepared for dispatch (count against slots). */
  readonly dispatching = new Map<string, string>();
  /** Tasks a human just acted on; they may use the reserved slot (in memory only). */
  readonly humanPriority = new Set<string>();
  /**
   * Set by `Engine.shutdown()`: results of runs aborted by the shutdown are not applied, so the
   * runs stay live in the store and the next startup's recovery marks them abandoned.
   */
  stopping = false;
  /** Called after a dirty transaction commits (the engine schedules a tick). */
  onCommit: (() => void) | undefined;

  constructor(readonly deps: EngineDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  now(): Date {
    return this.deps.clock.now();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  newId(kind: Parameters<EngineDeps['ids']['newId']>[0]): string {
    return this.deps.ids.newId(kind);
  }

  /** Run `fn` in one store transaction, then publish the events it emitted. */
  transact<T>(fn: (tx: Tx) => T): T {
    const now = this.now();
    let tx: Tx | undefined;
    const result = this.store.atomic((r) => {
      tx = new Tx(r, now);
      return fn(tx);
    });
    if (tx && tx.emitted.length > 0) this.publish(tx.emitted);
    if (tx?.dirty) this.onCommit?.();
    return result;
  }

  private publish(events: readonly EventRecord[]): void {
    try {
      this.deps.publisher?.publish(events);
      const forLeader = events.filter((e) => LEADER_EVENT_TYPES.includes(e.type));
      if (forLeader.length > 0) this.deps.leader?.notify(forLeader);
    } catch (err) {
      this.logger.error('event subscriber threw', { error: String(err) });
    }
  }

  track(promise: Promise<unknown>, kind: 'work' | 'run' = 'work'): void {
    const set = kind === 'work' ? this.work : this.runWork;
    const tracked = promise.catch((err: unknown) => {
      this.logger.error('background task failed', { error: String(err) });
    });
    set.add(tracked);
    void tracked.finally(() => set.delete(tracked));
  }
}
