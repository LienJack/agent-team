import type {
  AttentionRepository,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  WorkspaceRepository,
} from '@agent-team/core';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { attention, project, run, task, workspace } from '../schema/index.js';
import { changed, guardUnique, whereAll, type RepoDeps } from './shared.js';

export function projectRepo({ db }: RepoDeps): ProjectRepository {
  const ordered = () => db.select().from(project).orderBy(asc(project.created_at), asc(project.id));
  return {
    get: (id) => db.select().from(project).where(eq(project.id, id)).get(),
    getByName: (name) => db.select().from(project).where(eq(project.name, name)).get(),
    list: () => ordered().all(),
    insert(row) {
      guardUnique('project', row, () => db.insert(project).values(row).run());
    },
    update: (row) =>
      guardUnique('project', row, () =>
        changed(db.update(project).set(row).where(eq(project.id, row.id)).run()),
      ),
  };
}

export function taskRepo({ db }: RepoDeps): TaskRepository {
  return {
    get: (id) => db.select().from(task).where(eq(task.id, id)).get(),
    list(filter = {}) {
      if (filter.statuses?.length === 0) return [];
      return db
        .select()
        .from(task)
        .where(
          whereAll(
            filter.project_id === undefined ? undefined : eq(task.project_id, filter.project_id),
            filter.parent_id === undefined ? undefined : eq(task.parent_id, filter.parent_id),
            filter.statuses === undefined ? undefined : inArray(task.status, [...filter.statuses]),
          ),
        )
        .orderBy(asc(task.created_at), asc(task.id))
        .all();
    },
    insert(row) {
      guardUnique('task', row, () => db.insert(task).values(row).run());
    },
    update(next, expectedVersion) {
      const stored = { ...next, version: expectedVersion + 1 };
      return guardUnique('task', stored, () =>
        db
          .update(task)
          .set(stored)
          .where(and(eq(task.id, next.id), eq(task.version, expectedVersion)))
          .returning()
          .get(),
      );
    },
  };
}

export function workspaceRepo({ db }: RepoDeps): WorkspaceRepository {
  return {
    get: (id) => db.select().from(workspace).where(eq(workspace.id, id)).get(),
    findCurrentByTask: (taskId) =>
      db
        .select()
        .from(workspace)
        .where(and(eq(workspace.task_id, taskId), ne(workspace.state, 'removed')))
        .orderBy(asc(workspace.created_at), asc(workspace.id))
        .limit(1)
        .get(),
    list(filter = {}) {
      if (filter.states?.length === 0) return [];
      return db
        .select()
        .from(workspace)
        .where(
          whereAll(
            filter.task_id === undefined ? undefined : eq(workspace.task_id, filter.task_id),
            filter.states === undefined ? undefined : inArray(workspace.state, [...filter.states]),
          ),
        )
        .orderBy(asc(workspace.created_at), asc(workspace.id))
        .all();
    },
    insert(row) {
      guardUnique('workspace', row, () => db.insert(workspace).values(row).run());
    },
    update: (row) =>
      guardUnique('workspace', row, () =>
        changed(db.update(workspace).set(row).where(eq(workspace.id, row.id)).run()),
      ),
  };
}

export function runRepo({ db }: RepoDeps): RunRepository {
  return {
    get: (id) => db.select().from(run).where(eq(run.id, id)).get(),
    getByDispatchId: (dispatchId) =>
      db.select().from(run).where(eq(run.dispatch_id, dispatchId)).get(),
    list(filter = {}) {
      if (filter.states?.length === 0) return [];
      return db
        .select()
        .from(run)
        .where(
          whereAll(
            filter.task_id === undefined ? undefined : eq(run.task_id, filter.task_id),
            filter.states === undefined ? undefined : inArray(run.state, [...filter.states]),
          ),
        )
        .orderBy(asc(run.started_at), asc(run.id))
        .all();
    },
    insert(row) {
      guardUnique('run', row, () => db.insert(run).values(row).run());
    },
    update: (row) =>
      guardUnique('run', row, () =>
        changed(db.update(run).set(row).where(eq(run.id, row.id)).run()),
      ),
  };
}

export function attentionRepo({ db }: RepoDeps): AttentionRepository {
  return {
    get: (id) => db.select().from(attention).where(eq(attention.id, id)).get(),
    list(filter = {}) {
      if (filter.statuses?.length === 0) return [];
      return db
        .select()
        .from(attention)
        .where(
          whereAll(
            filter.task_id === undefined ? undefined : eq(attention.task_id, filter.task_id),
            filter.statuses === undefined
              ? undefined
              : inArray(attention.status, [...filter.statuses]),
          ),
        )
        .orderBy(asc(attention.created_at), asc(attention.id))
        .all();
    },
    insert(row) {
      guardUnique('attention', row, () => db.insert(attention).values(row).run());
    },
    update: (row) =>
      guardUnique('attention', row, () =>
        changed(db.update(attention).set(row).where(eq(attention.id, row.id)).run()),
      ),
  };
}
