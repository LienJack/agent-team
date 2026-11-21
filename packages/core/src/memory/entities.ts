import type { Run } from '@agent-team/schema';
import { UniqueViolationError } from '../errors.js';
import type {
  AttentionFilter,
  AttentionRepository,
  ProjectRepository,
  RunFilter,
  RunRepository,
  TaskFilter,
  TaskRepository,
  WorkspaceFilter,
  WorkspaceRepository,
} from '../ports/repositories.js';
import {
  byCreated,
  byKeys,
  checkRunRefs,
  checkTaskRef,
  checkTaskRefs,
  checkWorkspace,
  copy,
  type StateRef,
} from './state.js';

// In-memory repositories of the spec §5 entities, with the same keys and foreign keys as SQLite.

export function projectRepo(s: StateRef): ProjectRepository {
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

export function taskRepo(s: StateRef): TaskRepository {
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
      checkTaskRefs(s(), task);
      s().tasks.set(task.id, copy(task));
    },
    update(next, expectedVersion) {
      const current = s().tasks.get(next.id);
      if (!current || current.version !== expectedVersion) return undefined;
      checkTaskRefs(s(), next);
      const stored = { ...copy(next), version: expectedVersion + 1 };
      s().tasks.set(next.id, stored);
      return copy(stored);
    },
  };
}

export function workspaceRepo(s: StateRef): WorkspaceRepository {
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
      checkWorkspace(s(), workspace);
      s().workspaces.set(workspace.id, copy(workspace));
    },
    update(workspace) {
      if (!s().workspaces.has(workspace.id)) return false;
      checkWorkspace(s(), workspace);
      s().workspaces.set(workspace.id, copy(workspace));
      return true;
    },
  };
}

const byStarted = byKeys<Run>(
  (r) => r.started_at,
  (r) => r.id,
);

export function runRepo(s: StateRef): RunRepository {
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
      checkRunRefs(s(), run);
      m.set(run.id, copy(run));
    },
    update(run) {
      if (!s().runs.has(run.id)) return false;
      checkRunRefs(s(), run);
      s().runs.set(run.id, copy(run));
      return true;
    },
  };
}

export function attentionRepo(s: StateRef): AttentionRepository {
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
      checkTaskRef(s(), 'attention', item);
      s().attention.set(item.id, copy(item));
    },
    update(item) {
      if (!s().attention.has(item.id)) return false;
      checkTaskRef(s(), 'attention', item);
      s().attention.set(item.id, copy(item));
      return true;
    },
  };
}
