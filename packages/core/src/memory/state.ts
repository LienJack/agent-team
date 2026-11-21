import type {
  Attention,
  EffectRecord,
  EventRecord,
  IdempotencyRecord,
  Message,
  OutboxItem,
  Project,
  Run,
  Task,
  Workspace,
} from '@agent-team/schema';
import { ForeignKeyViolationError, UniqueViolationError } from '../errors.js';

// Shared state and helpers of the in-memory store (store.ts, entities.ts, logs.ts).

export interface MemState {
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

export function emptyState(): MemState {
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

export const copy = <T>(value: T): T => structuredClone(value);

export function byKeys<T>(...keys: ((x: T) => string | number)[]) {
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

export const byCreated = byKeys<{ created_at: string; id: string }>(
  (x) => x.created_at,
  (x) => x.id,
);

export type StateRef = () => MemState;

/**
 * Foreign keys, checked like SQLite does (docs/adr/0007): a non-null reference must name an
 * existing row. Callers check unique keys first (SQLite reports those before foreign keys).
 */
export function requireRef(
  entity: string,
  column: string,
  value: string | null,
  exists: (id: string) => boolean,
): void {
  if (value !== null && !exists(value)) {
    throw new ForeignKeyViolationError(entity, `${column} ${value}`);
  }
}

/** Task references: project, parent task, current run. */
export function checkTaskRefs(st: MemState, task: Task): void {
  requireRef('task', 'project_id', task.project_id, (id) => st.projects.has(id));
  requireRef('task', 'parent_id', task.parent_id, (id) => id === task.id || st.tasks.has(id));
  requireRef('task', 'current_run_id', task.current_run_id, (id) => st.runs.has(id));
}

/** Workspace → task, and at most one non-removed workspace per task (partial unique index). */
export function checkWorkspace(st: MemState, ws: Workspace): void {
  if (ws.state !== 'removed') {
    for (const other of st.workspaces.values()) {
      if (other.id !== ws.id && other.task_id === ws.task_id && other.state !== 'removed') {
        throw new UniqueViolationError('workspace', `task_id ${ws.task_id} (non-removed)`);
      }
    }
  }
  requireRef('workspace', 'task_id', ws.task_id, (id) => st.tasks.has(id));
}

export function checkRunRefs(st: MemState, run: Run): void {
  requireRef('run', 'task_id', run.task_id, (id) => st.tasks.has(id));
  requireRef('run', 'workspace_id', run.workspace_id, (id) => st.workspaces.has(id));
}

/** attention / outbox → task (nullable). */
export function checkTaskRef(st: MemState, entity: string, item: Attention | OutboxItem): void {
  requireRef(entity, 'task_id', item.task_id, (id) => st.tasks.has(id));
}
