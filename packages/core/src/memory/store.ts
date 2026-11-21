import type {
  Attention,
  EffectKind,
  EffectRecord,
  EventRecord,
  IdempotencyRecord,
  KvEntry,
  Message,
  MessageChannel,
  NewEvent,
  NewMessage,
  OutboxItem,
  Project,
  Run,
  Task,
  Workspace,
} from '@agent-team/schema';
import { UniqueViolationError } from '../errors.js';
import type {
  AttentionFilter,
  AttentionRepository,
  EffectInput,
  EffectRepository,
  EventRepository,
  IdempotencyRepository,
  KvRepository,
  MessageFilter,
  MessageRepository,
  OutboxFilter,
  OutboxRepository,
  ProjectRepository,
  Repositories,
  RunFilter,
  RunRepository,
  Store,
  TaskFilter,
  TaskRepository,
  WorkspaceFilter,
  WorkspaceRepository,
} from '../ports/repositories.js';

interface MemState {
  projects: Map<string, Project>;
  tasks: Map<string, Task>;
  workspaces: Map<string, Workspace>;
  runs: Map<string, Run>;
  attention: Map<string, Attention>;
  messages: Map<string, Message>;
  events: EventRecord[];
  effects: Map<string, EffectRecord>;
  outbox: Map<string, OutboxItem>;
  idempotency: Map<string, IdempotencyRecord>;
  kv: Map<string, string>;
  seq: { event: number; effect: number; message: number };
}

function emptyState(): MemState {
  return {
    projects: new Map(),
    tasks: new Map(),
    workspaces: new Map(),
    runs: new Map(),
    attention: new Map(),
    messages: new Map(),
    events: [],
    effects: new Map(),
    outbox: new Map(),
    idempotency: new Map(),
    kv: new Map(),
    seq: { event: 0, effect: 0, message: 0 },
  };
}

const copy = <T>(value: T): T => structuredClone(value);

function byKeys<T>(...keys: ((x: T) => string | number)[]) {
  return (a: T, b: T): number => {
    for (const key of keys) {
      const ka = key(a);
      const kb = key(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
    }
    return 0;
  };
}

const byCreated = byKeys<{ created_at: string; id: string }>(
  (x) => x.created_at,
  (x) => x.id,
);

/**
 * In-memory `Store` for tests and the core engine's own unit tests. Transactions snapshot the
 * whole state and restore it on throw, so rollback semantics match a real database.
 */
export class InMemoryStore implements Store {
  private state: MemState = emptyState();
  private depth = 0;

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

  constructor() {
    const s = () => this.state;
    this.projects = projectRepo(s);
    this.tasks = taskRepo(s);
    this.workspaces = workspaceRepo(s);
    this.runs = runRepo(s);
    this.attention = attentionRepo(s);
    this.messages = messageRepo(s);
    this.events = eventRepo(s);
    this.effects = effectRepo(s);
    this.outbox = outboxRepo(s);
    this.idempotency = idempotencyRepo(s);
    this.kv = kvRepo(s);
  }

  atomic<T>(fn: (tx: Repositories) => T): T {
    if (this.depth > 0) return fn(this);
    const snapshot = structuredClone(this.state);
    this.depth++;
    try {
      const result = fn(this);
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('atomic() callback must be synchronous (it returned a thenable)');
      }
      return result;
    } catch (err) {
      this.state = snapshot;
      throw err;
    } finally {
      this.depth--;
    }
  }
}

type StateRef = () => MemState;

function projectRepo(s: StateRef): ProjectRepository {
  return {
    get: (id) => copy(s().projects.get(id)),
    getByName: (name) => copy([...s().projects.values()].find((p) => p.name === name)),
    list: () => [...s().projects.values()].sort(byCreated).map(copy),
    insert(project) {
      const m = s().projects;
      if (m.has(project.id)) throw new UniqueViolationError('project', `id ${project.id}`);
      if ([...m.values()].some((p) => p.name === project.name)) {
        throw new UniqueViolationError('project', `name ${project.name}`);
      }
      m.set(project.id, copy(project));
    },
    update(project) {
      const m = s().projects;
      if (!m.has(project.id)) return false;
      m.set(project.id, copy(project));
      return true;
    },
  };
}

function taskRepo(s: StateRef): TaskRepository {
  return {
    get: (id) => copy(s().tasks.get(id)),
    list(filter: TaskFilter = {}) {
      return [...s().tasks.values()]
        .filter(
          (t) =>
            (filter.project_id === undefined || t.project_id === filter.project_id) &&
            (filter.parent_id === undefined || t.parent_id === filter.parent_id) &&
            (filter.statuses === undefined || filter.statuses.includes(t.status)),
        )
        .sort(byCreated)
        .map(copy);
    },
    insert(task) {
      if (s().tasks.has(task.id)) throw new UniqueViolationError('task', `id ${task.id}`);
      s().tasks.set(task.id, copy(task));
    },
    update(next, expectedVersion) {
      const current = s().tasks.get(next.id);
      if (!current || current.version !== expectedVersion) return undefined;
      const stored = { ...copy(next), version: expectedVersion + 1 };
      s().tasks.set(next.id, stored);
      return copy(stored);
    },
  };
}

function workspaceRepo(s: StateRef): WorkspaceRepository {
  return {
    get: (id) => copy(s().workspaces.get(id)),
    findCurrentByTask: (taskId) =>
      copy(
        [...s().workspaces.values()]
          .sort(byCreated)
          .find((w) => w.task_id === taskId && w.state !== 'removed'),
      ),
    list(filter: WorkspaceFilter = {}) {
      return [...s().workspaces.values()]
        .filter(
          (w) =>
            (filter.task_id === undefined || w.task_id === filter.task_id) &&
            (filter.states === undefined || filter.states.includes(w.state)),
        )
        .sort(byCreated)
        .map(copy);
    },
    insert(workspace) {
      if (s().workspaces.has(workspace.id)) {
        throw new UniqueViolationError('workspace', `id ${workspace.id}`);
      }
      s().workspaces.set(workspace.id, copy(workspace));
    },
    update(workspace) {
      if (!s().workspaces.has(workspace.id)) return false;
      s().workspaces.set(workspace.id, copy(workspace));
      return true;
    },
  };
}

const byStarted = byKeys<Run>(
  (r) => r.started_at,
  (r) => r.id,
);

function runRepo(s: StateRef): RunRepository {
  return {
    get: (id) => copy(s().runs.get(id)),
    getByDispatchId: (dispatchId) =>
      copy([...s().runs.values()].find((r) => r.dispatch_id === dispatchId)),
    list(filter: RunFilter = {}) {
      return [...s().runs.values()]
        .filter(
          (r) =>
            (filter.task_id === undefined || r.task_id === filter.task_id) &&
            (filter.states === undefined || filter.states.includes(r.state)),
        )
        .sort(byStarted)
        .map(copy);
    },
    insert(run) {
      const m = s().runs;
      if (m.has(run.id)) throw new UniqueViolationError('run', `id ${run.id}`);
      if ([...m.values()].some((r) => r.dispatch_id === run.dispatch_id)) {
        throw new UniqueViolationError('run', `dispatch_id ${run.dispatch_id}`);
      }
      m.set(run.id, copy(run));
    },
    update(run) {
      if (!s().runs.has(run.id)) return false;
      s().runs.set(run.id, copy(run));
      return true;
    },
  };
}

function attentionRepo(s: StateRef): AttentionRepository {
  return {
    get: (id) => copy(s().attention.get(id)),
    list(filter: AttentionFilter = {}) {
      return [...s().attention.values()]
        .filter(
          (a) =>
            (filter.task_id === undefined || a.task_id === filter.task_id) &&
            (filter.statuses === undefined || filter.statuses.includes(a.status)),
        )
        .sort(byCreated)
        .map(copy);
    },
    insert(item) {
      if (s().attention.has(item.id)) throw new UniqueViolationError('attention', `id ${item.id}`);
      s().attention.set(item.id, copy(item));
    },
    update(item) {
      if (!s().attention.has(item.id)) return false;
      s().attention.set(item.id, copy(item));
      return true;
    },
  };
}

function messageRepo(s: StateRef): MessageRepository {
  const find = (channel: MessageChannel, clientMsgId: string) =>
    [...s().messages.values()].find(
      (m) => m.channel === channel && m.client_msg_id === clientMsgId,
    );
  return {
    get: (id) => copy(s().messages.get(id)),
    findByClientMsgId: (channel, clientMsgId) => copy(find(channel, clientMsgId)),
    list(filter: MessageFilter = {}) {
      const items = [...s().messages.values()]
        .filter(
          (m) =>
            (filter.channel === undefined || m.channel === filter.channel) &&
            (filter.afterSeq === undefined || m.seq > filter.afterSeq),
        )
        .sort((a, b) => a.seq - b.seq);
      return (filter.limit === undefined ? items : items.slice(0, filter.limit)).map(copy);
    },
    insert(message: NewMessage) {
      const st = s();
      if (st.messages.has(message.id)) {
        throw new UniqueViolationError('message', `id ${message.id}`);
      }
      if (find(message.channel, message.client_msg_id)) {
        throw new UniqueViolationError('message', `client_msg_id ${message.client_msg_id}`);
      }
      st.seq.message += 1;
      const stored: Message = { ...copy(message), seq: st.seq.message };
      st.messages.set(stored.id, stored);
      return copy(stored);
    },
    update(message) {
      if (!s().messages.has(message.id)) return false;
      s().messages.set(message.id, copy(message));
      return true;
    },
  };
}

function eventRepo(s: StateRef): EventRepository {
  return {
    append(event: NewEvent) {
      const st = s();
      st.seq.event += 1;
      const stored = { ...copy(event), seq: st.seq.event } as EventRecord;
      st.events.push(stored);
      return copy(stored);
    },
    listAfter(afterSeq, limit) {
      const items = s().events.filter((e) => e.seq > afterSeq);
      return (limit === undefined ? items : items.slice(0, limit)).map(copy);
    },
    lastSeq: () => s().seq.event,
  };
}

const effectId = (kind: EffectKind, key: string) => `${kind}\u0000${key}`;

function effectRepo(s: StateRef): EffectRepository {
  const sorted = () => [...s().effects.values()].sort((a, b) => a.seq - b.seq);
  return {
    upsert(input: EffectInput) {
      const st = s();
      const id = effectId(input.kind, input.key);
      const existing = st.effects.get(id);
      let stored: EffectRecord;
      if (existing) {
        stored = {
          ...existing,
          payload: copy(input.payload),
          due: input.due,
          generation: existing.generation + 1,
          attempts: 0,
          error: null,
        };
      } else {
        st.seq.effect += 1;
        stored = {
          kind: input.kind,
          key: input.key,
          payload: copy(input.payload),
          seq: st.seq.effect,
          generation: 1,
          attempts: 0,
          due: input.due,
          error: null,
        };
      }
      st.effects.set(id, stored);
      return copy(stored);
    },
    get: (kind, key) => copy(s().effects.get(effectId(kind, key))),
    list: () => sorted().map(copy),
    listDue(now, limit) {
      const items = sorted().filter((e) => e.due <= now);
      return (limit === undefined ? items : items.slice(0, limit)).map(copy);
    },
    delete(kind, key, generation) {
      const id = effectId(kind, key);
      const existing = s().effects.get(id);
      if (!existing || existing.generation !== generation) return false;
      s().effects.delete(id);
      return true;
    },
    recordFailure(kind, key, generation, failure) {
      const id = effectId(kind, key);
      const existing = s().effects.get(id);
      if (!existing || existing.generation !== generation) return undefined;
      const stored = { ...existing, ...failure };
      s().effects.set(id, stored);
      return copy(stored);
    },
  };
}

function outboxRepo(s: StateRef): OutboxRepository {
  return {
    get: (id) => copy(s().outbox.get(id)),
    findBySignature: (signature) =>
      copy([...s().outbox.values()].find((o) => o.signature === signature)),
    list(filter: OutboxFilter = {}) {
      return [...s().outbox.values()]
        .filter(
          (o) =>
            (filter.task_id === undefined || o.task_id === filter.task_id) &&
            (filter.statuses === undefined || filter.statuses.includes(o.status)),
        )
        .sort(byCreated)
        .map(copy);
    },
    insert(item) {
      const m = s().outbox;
      if (m.has(item.id)) throw new UniqueViolationError('outbox', `id ${item.id}`);
      if ([...m.values()].some((o) => o.signature === item.signature)) {
        throw new UniqueViolationError('outbox', `signature ${item.signature}`);
      }
      m.set(item.id, copy(item));
    },
    update(item) {
      if (!s().outbox.has(item.id)) return false;
      s().outbox.set(item.id, copy(item));
      return true;
    },
  };
}

const idemId = (caller: string, requestId: string) => `${caller}\u0000${requestId}`;

function idempotencyRepo(s: StateRef): IdempotencyRepository {
  return {
    get: (caller, requestId) => copy(s().idempotency.get(idemId(caller, requestId))),
    listByState(state) {
      return [...s().idempotency.values()]
        .filter((r) => r.state === state)
        .sort(
          byKeys<IdempotencyRecord>(
            (r) => r.created_at,
            (r) => r.caller,
            (r) => r.request_id,
          ),
        )
        .map(copy);
    },
    insert(record) {
      const id = idemId(record.caller, record.request_id);
      if (s().idempotency.has(id)) {
        throw new UniqueViolationError('idempotency', `${record.caller}/${record.request_id}`);
      }
      s().idempotency.set(id, copy(record));
    },
    update(record) {
      const id = idemId(record.caller, record.request_id);
      if (!s().idempotency.has(id)) return false;
      s().idempotency.set(id, copy(record));
      return true;
    },
    delete: (caller, requestId) => s().idempotency.delete(idemId(caller, requestId)),
  };
}

function kvRepo(s: StateRef): KvRepository {
  return {
    get: (key) => s().kv.get(key),
    set: (key, value) => void s().kv.set(key, value),
    delete: (key) => s().kv.delete(key),
    list(prefix = '') {
      return [...s().kv.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]): KvEntry => ({ key, value }));
    },
  };
}
