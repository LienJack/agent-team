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
} from '../ports/repositories.js';
import { attentionRepo, projectRepo, runRepo, taskRepo, workspaceRepo } from './entities.js';
import { effectRepo, eventRepo, idempotencyRepo, kvRepo, messageRepo, outboxRepo } from './logs.js';
import { emptyState, type MemState } from './state.js';

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
