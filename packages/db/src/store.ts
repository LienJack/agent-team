import type {
  AttentionRepository,
  EffectRepository,
  EventRepository,
  IdempotencyRepository,
  KvRepository,
  MessageRepository,
  OutboxRepository,
  ProjectRepository,
  Repositories,
  RunRepository,
  Store,
  TaskRepository,
  WorkspaceRepository,
} from '@agent-team/core';
import type { DatabaseSync } from 'node:sqlite';
import { drizzleNodeSqlite } from './driver/node-sqlite.js';
import { openDatabase, type OpenOptions } from './open.js';
import { attentionRepo, projectRepo, runRepo, taskRepo, workspaceRepo } from './repos/entities.js';
import { effectRepo, eventRepo, messageRepo } from './repos/logs.js';
import { idempotencyRepo, kvRepo, outboxRepo } from './repos/records.js';
import type { RepoDeps } from './repos/shared.js';

const isThenable = (value: unknown): boolean =>
  value != null && typeof (value as { then?: unknown }).then === 'function';

/**
 * `Store` over one synchronous `node:sqlite` connection (docs/adr/0002, 0007).
 *
 * `atomic()` is `BEGIN IMMEDIATE` … `COMMIT`; a nested call is a SAVEPOINT inside the outer
 * transaction, so an inner throw that the caller catches only undoes the inner writes. Repository
 * methods made of several statements run inside `atomic()` too, so they are atomic when called
 * on their own.
 */
export class SqliteStore implements Store {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly workspaces: WorkspaceRepository;
  readonly runs: RunRepository;
  readonly attention: AttentionRepository;
  readonly messages: MessageRepository;
  readonly events: EventRepository;
  readonly effects: EffectRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
  readonly kv: KvRepository;

  private depth = 0;

  constructor(private readonly client: DatabaseSync) {
    const deps: RepoDeps = {
      db: drizzleNodeSqlite(client),
      atomic: (fn) => this.atomic(() => fn()),
    };
    this.projects = projectRepo(deps);
    this.tasks = taskRepo(deps);
    this.workspaces = workspaceRepo(deps);
    this.runs = runRepo(deps);
    this.attention = attentionRepo(deps);
    this.messages = messageRepo(deps);
    this.events = eventRepo(deps);
    this.effects = effectRepo(deps);
    this.outbox = outboxRepo(deps);
    this.idempotency = idempotencyRepo(deps);
    this.kv = kvRepo(deps);
  }

  /** Open (and migrate) the database file at `path`. */
  static open(path: string, options: OpenOptions = {}): SqliteStore {
    return new SqliteStore(openDatabase(path, options));
  }

  /** The underlying connection (tests and diagnostics). */
  get connection(): DatabaseSync {
    return this.client;
  }

  atomic<T>(fn: (tx: Repositories) => T): T {
    const level = this.depth;
    const savepoint = `atomic_${level}`;
    this.client.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth = level + 1;
    let result: T;
    try {
      result = fn(this);
      if (isThenable(result)) {
        throw new TypeError('atomic() callback must be synchronous (it returned a thenable)');
      }
    } catch (err) {
      this.depth = level;
      this.undo(level, savepoint);
      throw err;
    }
    this.depth = level;
    try {
      this.client.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    } catch (err) {
      this.undo(level, savepoint);
      throw err;
    }
    return result;
  }

  /** Close the connection (idempotent). */
  close(): void {
    if (this.client.isOpen) this.client.close();
  }

  private undo(level: number, savepoint: string): void {
    // SQLite may already have rolled the whole transaction back (e.g. SQLITE_FULL).
    if (!this.client.isTransaction) return;
    try {
      if (level === 0) {
        this.client.exec('ROLLBACK');
      } else {
        this.client.exec(`ROLLBACK TO ${savepoint}`);
        this.client.exec(`RELEASE ${savepoint}`);
      }
    } catch {
      // Keep the caller's original error; a failed rollback leaves nothing better to report.
    }
  }
}
