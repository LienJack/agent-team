import type { Attention, Project, Run, Task, Workspace } from '@agent-team/schema';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// Drizzle tables for the spec §5 entities (+ docs/adr/0004 fields). Column names equal the Zod
// field names in packages/schema, so a selected row is the domain object as-is (checked by the
// type assertions in ../repos/rows.ts). Only type imports from @agent-team/schema, so drizzle-kit
// can load this file without a built schema package.
//
// Foreign keys (docs/adr/0007): task → project, parent task, current run; workspace, run,
// attention, outbox → task; run → workspace. No ON DELETE actions (these rows are never deleted).
// `PRAGMA foreign_keys = ON` is set on every connection (see ../open.ts); the in-memory store
// enforces the same keys, so the repository contract is identical for both.

export const project = sqliteTable('project', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  repo_path: text().notNull(),
  base_branch: text().notNull(),
  checks: text({ mode: 'json' }).$type<Project['checks']>().notNull(),
  allow_network: integer({ mode: 'boolean' }).notNull().default(false),
  created_at: text().notNull(),
});

export const task = sqliteTable(
  'task',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => project.id),
    parent_id: text().references((): AnySQLiteColumn => task.id),
    title: text().notNull(),
    tier: text().$type<Task['tier']>().notNull(),
    ticket_md: text().notNull(),
    owned_paths: text({ mode: 'json' }).$type<Task['owned_paths']>().notNull(),
    priority: integer().notNull(),
    status: text().$type<Task['status']>().notNull(),
    impl_role: text().notNull(),
    fix_rounds: integer().notNull(),
    leader_retries: integer().notNull().default(0),
    attempts: integer().notNull(),
    blocked_reason: text(),
    version: integer().notNull(),
    // task ↔ run is a cycle: the run is inserted first, then the task points at it
    current_run_id: text().references((): AnySQLiteColumn => run.id),
    retry_at: text(),
    fix_notes: text(),
    recovery_note: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    index('task_status_idx').on(t.status),
    index('task_project_idx').on(t.project_id),
    index('task_parent_idx').on(t.parent_id),
  ],
);

export const workspace = sqliteTable(
  'workspace',
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => task.id),
    path: text().notNull(),
    branch: text().notNull(),
    base_sha: text().notNull(),
    head_sha: text(),
    accepted_base_sha: text(),
    state: text().$type<Workspace['state']>().notNull(),
    created_at: text().notNull(),
    removed_at: text(),
  },
  (t) => [
    index('workspace_task_idx').on(t.task_id),
    index('workspace_state_idx').on(t.state),
    // at most one non-removed workspace per task (WorkspaceSchema)
    uniqueIndex('workspace_current_task_unique')
      .on(t.task_id)
      .where(sql`state <> 'removed'`),
  ],
);

export const run = sqliteTable(
  'run',
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => task.id),
    workspace_id: text()
      .notNull()
      .references(() => workspace.id),
    dispatch_id: text().notNull().unique(),
    kind: text().$type<Run['kind']>().notNull(),
    role: text().notNull(),
    model_alias: text().notNull(),
    runner: text().$type<Run['runner']>().notNull(),
    model: text().notNull(),
    state: text().$type<Run['state']>().notNull(),
    outcome: text().$type<NonNullable<Run['outcome']>>(),
    reject_reason: text(),
    error: text(),
    session_ref: text(),
    receipt: text({ mode: 'json' }).$type<NonNullable<Run['receipt']>>(),
    usage: text({ mode: 'json' }).$type<NonNullable<Run['usage']>>(),
    cost_usd: real(),
    log_dir: text().notNull(),
    pid: integer(),
    pid_started_at: text(),
    launched_at: text(),
    started_at: text().notNull(),
    ended_at: text(),
  },
  (t) => [index('run_task_idx').on(t.task_id), index('run_state_idx').on(t.state)],
);

export const attention = sqliteTable(
  'attention',
  {
    id: text().primaryKey(),
    task_id: text().references(() => task.id),
    kind: text().$type<Attention['kind']>().notNull(),
    question: text().notNull(),
    options: text({ mode: 'json' }).$type<Attention['options']>().notNull(),
    status: text().$type<Attention['status']>().notNull(),
    answer: text(),
    answered_via: text().$type<NonNullable<Attention['answered_via']>>(),
    created_at: text().notNull(),
    answered_at: text(),
  },
  (t) => [index('attention_status_idx').on(t.status), index('attention_task_idx').on(t.task_id)],
);
