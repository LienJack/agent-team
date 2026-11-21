import type {
  Attention,
  EffectKind,
  EffectRecord,
  EventRecord,
  IdempotencyRecord,
  JsonValue,
  KvEntry,
  Message,
  MessageChannel,
  NewEvent,
  NewMessage,
  OutboxItem,
  Project,
  Run,
  RunState,
  Task,
  TaskStatus,
  Workspace,
  WorkspaceState,
} from '@agent-team/schema';

// Repository ports (spec §5). All methods are SYNCHRONOUS (SQLite drivers are synchronous and a
// sync transaction cannot interleave with other work; see docs/adr/0002).
//
// Contract for every implementation (checked by `runRepositoryContract` in core/testing):
// - Returned objects are copies: mutating them never changes stored state.
// - `insert` throws `UniqueViolationError` on any unique-key conflict and stores nothing.
// - `update(x): boolean` replaces the whole row by primary key; false if the row does not exist.
// - Lists are ordered as documented (ties broken by id) and filters combine with AND.
// - Timestamps are ISO UTC strings as produced by `Date#toISOString()`; comparing them as text
//   gives time order.

export interface ProjectRepository {
  get(id: string): Project | undefined;
  getByName(name: string): Project | undefined;
  /** Ordered by created_at, id. */
  list(): Project[];
  /** Unique: id, name. */
  insert(project: Project): void;
  update(project: Project): boolean;
}

export interface TaskFilter {
  project_id?: string;
  statuses?: readonly TaskStatus[];
  parent_id?: string;
}

export interface TaskRepository {
  get(id: string): Task | undefined;
  /** Ordered by created_at, id. */
  list(filter?: TaskFilter): Task[];
  /** Unique: id. */
  insert(task: Task): void;
  /**
   * Optimistic compare-and-set. Persists `next` with `version = expectedVersion + 1` only if the
   * stored row still has `expectedVersion`; `next.version` is ignored. Returns the stored task,
   * or `undefined` (nothing written) when the row is missing or its version differs.
   */
  update(next: Task, expectedVersion: number): Task | undefined;
}

export interface WorkspaceFilter {
  task_id?: string;
  states?: readonly WorkspaceState[];
}

export interface WorkspaceRepository {
  get(id: string): Workspace | undefined;
  /** The task's workspace whose state is not `removed` (at most one exists). */
  findCurrentByTask(taskId: string): Workspace | undefined;
  /** Ordered by created_at, id. */
  list(filter?: WorkspaceFilter): Workspace[];
  /** Unique: id. */
  insert(workspace: Workspace): void;
  update(workspace: Workspace): boolean;
}

export interface RunFilter {
  task_id?: string;
  states?: readonly RunState[];
}

export interface RunRepository {
  get(id: string): Run | undefined;
  getByDispatchId(dispatchId: string): Run | undefined;
  /** Ordered by started_at, id. */
  list(filter?: RunFilter): Run[];
  /** Unique: id, dispatch_id. */
  insert(run: Run): void;
  update(run: Run): boolean;
}

export interface AttentionFilter {
  task_id?: string;
  statuses?: readonly Attention['status'][];
}

export interface AttentionRepository {
  get(id: string): Attention | undefined;
  /** Ordered by created_at, id. */
  list(filter?: AttentionFilter): Attention[];
  /** Unique: id. */
  insert(item: Attention): void;
  update(item: Attention): boolean;
}

export interface MessageFilter {
  channel?: MessageChannel;
  /** Only messages with seq > afterSeq. */
  afterSeq?: number;
  limit?: number;
}

export interface MessageRepository {
  get(id: string): Message | undefined;
  findByClientMsgId(channel: MessageChannel, clientMsgId: string): Message | undefined;
  /** Ordered by seq ascending. */
  list(filter?: MessageFilter): Message[];
  /** Assigns the next seq (increasing across all channels). Unique: id, (channel, client_msg_id). */
  insert(message: NewMessage): Message;
  update(message: Message): boolean;
}

export interface EventRepository {
  /** Assigns the next seq (1, 2, 3, … never reused) and returns the stored record. */
  append(event: NewEvent): EventRecord;
  /** Events with seq > afterSeq, ascending, at most `limit` (default: all). */
  listAfter(afterSeq: number, limit?: number): EventRecord[];
  /** Highest seq written so far; 0 when empty. */
  lastSeq(): number;
}

export interface EffectInput {
  kind: EffectKind;
  key: string;
  payload: JsonValue;
  due: string;
}

export interface EffectRepository {
  /**
   * Insert or replace (kind, key). New rows get the next effect seq, generation 1, attempts 0,
   * error null. An existing row keeps its seq, gets the new payload and due, generation + 1,
   * attempts 0 and error null. Returns the stored record.
   */
  upsert(input: EffectInput): EffectRecord;
  get(kind: EffectKind, key: string): EffectRecord | undefined;
  /** All effects ordered by seq. */
  list(): EffectRecord[];
  /** Effects with due <= now, ordered by seq, at most `limit`. */
  listDue(now: string, limit?: number): EffectRecord[];
  /** Delete only if the stored generation equals `generation`. True if a row was deleted. */
  delete(kind: EffectKind, key: string, generation: number): boolean;
  /**
   * Record a failed attempt if the stored generation equals `generation`: sets attempts, due and
   * error. Returns the updated record, or undefined when missing or superseded.
   */
  recordFailure(
    kind: EffectKind,
    key: string,
    generation: number,
    failure: { attempts: number; due: string; error: string },
  ): EffectRecord | undefined;
}

export interface OutboxFilter {
  statuses?: readonly OutboxItem['status'][];
  task_id?: string;
}

export interface OutboxRepository {
  get(id: string): OutboxItem | undefined;
  findBySignature(signature: string): OutboxItem | undefined;
  /** Ordered by created_at, id. */
  list(filter?: OutboxFilter): OutboxItem[];
  /** Unique: id, signature. */
  insert(item: OutboxItem): void;
  update(item: OutboxItem): boolean;
}

export interface IdempotencyRepository {
  get(caller: string, requestId: string): IdempotencyRecord | undefined;
  /** Ordered by created_at, caller, request_id. */
  listByState(state: IdempotencyRecord['state']): IdempotencyRecord[];
  /** Unique: (caller, request_id). */
  insert(record: IdempotencyRecord): void;
  update(record: IdempotencyRecord): boolean;
  delete(caller: string, requestId: string): boolean;
}

export interface KvRepository {
  get(key: string): string | undefined;
  /** Insert or overwrite. */
  set(key: string, value: string): void;
  delete(key: string): boolean;
  /** Entries whose key starts with `prefix` (all when omitted), ordered by key. */
  list(prefix?: string): KvEntry[];
}

/** Every repository, as seen inside or outside a transaction. */
export interface Repositories {
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
}

/**
 * The persistence port the engine is built on. Reads may happen outside `atomic`; every write
 * the engine makes happens inside it.
 */
export interface Store extends Repositories {
  /**
   * Run `fn` as one transaction and return its result. All writes commit together, or none do
   * when `fn` throws (the error is rethrown unchanged). `fn` must be synchronous: if it returns
   * a thenable the implementation rolls back and throws. A nested call joins the outer
   * transaction; callers must not rely on what remains after catching an inner throw
   * (implementations may or may not use savepoints).
   */
  atomic<T>(fn: (tx: Repositories) => T): T;
}
