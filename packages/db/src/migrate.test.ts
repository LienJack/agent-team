import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, SqliteStore } from './index.js';
import { appliedMigrations, applyMigrations, MIGRATIONS_DIR, readMigrations } from './migrate.js';
import { tempDir } from './testing.js';

const TABLES = [
  'attention',
  'counter',
  'effect',
  'event',
  'idempotency',
  'kv',
  'message',
  'migration',
  'outbox',
  'project',
  'run',
  'task',
  'workspace',
];

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
beforeEach(() => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'data', 'team.db');
});
afterEach(() => tmp.remove());

function tableNames(store: SqliteStore): string[] {
  return (
    store.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function pragma(store: SqliteStore, name: string): unknown {
  const row = store.connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

describe('migrations (spec §14 db: 遷移可從空庫套用)', () => {
  it('the committed migrations are timestamped drizzle-kit SQL files', () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) {
      expect(m.tag).toMatch(/^\d{14}_[a-z0-9_]+$/);
      expect(existsSync(join(MIGRATIONS_DIR, `${m.tag}.sql`))).toBe(true);
      expect(m.statements.length).toBeGreaterThan(0);
    }
  });

  it('apply from an empty database, creating the parent directory', () => {
    const store = createSqliteStore({ path: dbPath });
    try {
      expect(tableNames(store)).toEqual(TABLES);
      const applied = appliedMigrations(store.connection);
      expect(applied.map((m) => m.tag)).toEqual(readMigrations().map((m) => m.tag));
      expect(applied[0]?.applied_at).toMatch(/Z$/);
    } finally {
      store.close();
    }
  });

  it('sets WAL, busy_timeout=5000 and foreign keys on the connection it returns', () => {
    const store = createSqliteStore({ path: dbPath });
    try {
      expect(pragma(store, 'journal_mode')).toBe('wal');
      expect(pragma(store, 'busy_timeout')).toBe(5000);
      expect(pragma(store, 'foreign_keys')).toBe(1);
    } finally {
      store.close();
    }
  });

  it('is idempotent on reopen', () => {
    const first = createSqliteStore({ path: dbPath });
    const before = appliedMigrations(first.connection);
    first.close();
    const second = createSqliteStore({ path: dbPath });
    try {
      expect(appliedMigrations(second.connection)).toEqual(before);
      expect(applyMigrations(second.connection)).toEqual([]);
      expect(tableNames(second)).toEqual(TABLES);
    } finally {
      second.close();
    }
  });

  it('applies only the new migration when one is added later', () => {
    const dir = join(tmp.dir, 'drizzle');
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    SqliteStore.open(dbPath, { migrationsDir: dir }).close();

    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
    };
    const last = journal.entries.at(-1)!;
    const tag = '29990101000000_extra';
    journal.entries.push({ idx: last.idx + 1, when: last.when + 1, tag, breakpoints: true });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(
      join(dir, `${tag}.sql`),
      'CREATE TABLE `extra` (`id` text PRIMARY KEY NOT NULL);',
    );

    const store = SqliteStore.open(dbPath, { migrationsDir: dir });
    try {
      expect(tableNames(store)).toContain('extra');
      expect(
        appliedMigrations(store.connection)
          .map((m) => m.tag)
          .at(-1),
      ).toBe(tag);
    } finally {
      store.close();
    }
  });

  it('refuses a database whose applied migration was edited afterwards', () => {
    const dir = join(tmp.dir, 'drizzle');
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    SqliteStore.open(dbPath, { migrationsDir: dir }).close();
    const firstTag = readMigrations(dir)[0]!.tag;
    appendFileSync(join(dir, `${firstTag}.sql`), '\n-- edited\n');
    expect(() => SqliteStore.open(dbPath, { migrationsDir: dir })).toThrow(/hash mismatch/);
  });

  it('refuses a database written by a newer build (unknown migration rows)', () => {
    const store = createSqliteStore({ path: dbPath });
    store.connection
      .prepare('INSERT INTO migration (tag, hash, created_at, applied_at) VALUES (?, ?, ?, ?)')
      .run('29990101000000_future', 'x', 1, '2999-01-01T00:00:00.000Z');
    store.close();
    expect(() => createSqliteStore({ path: dbPath })).toThrow(/newer version/);
  });

  /** A copy of the migrations folder with only the first (init) migration in its journal. */
  function initOnly(): string {
    const dir = join(tmp.dir, 'init-only');
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    for (const e of journal.entries.slice(1)) rmSync(join(dir, `${e.tag}.sql`));
    journal.entries = journal.entries.slice(0, 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  function rawInit(rows: string[]): void {
    SqliteStore.open(dbPath, { migrationsDir: initOnly() }).close();
    const db = new DatabaseSync(dbPath);
    for (const sql of rows) db.exec(sql);
    db.close();
  }

  const T0 = '2026-11-21T00:00:00.000Z';
  const PROJECT = `INSERT INTO project VALUES ('p_1', 'demo', '/r', 'main', '[]', '${T0}')`;
  const task = (id: string, project: string) =>
    `INSERT INTO task (id, project_id, title, tier, ticket_md, owned_paths, priority, status,
      impl_role, fix_rounds, attempts, version, created_at, updated_at) VALUES ('${id}',
      '${project}', 'x', 'C', 'x', '[]', 0, 'queued', 'impl_C', 0, 0, 1, '${T0}', '${T0}')`;
  const ws = (id: string, state: string) =>
    `INSERT INTO workspace (id, task_id, path, branch, base_sha, state, created_at)
      VALUES ('${id}', 't_1', '/w/${id}', 'team/t_1', 'aaaaaaa1', '${state}', '${T0}')`;

  it('upgrades a database with rows from before the foreign keys, keeping the data', () => {
    rawInit([PROJECT, task('t_1', 'p_1'), ws('w_1', 'removed'), ws('w_2', 'active')]);
    const store = createSqliteStore({ path: dbPath });
    try {
      expect(appliedMigrations(store.connection).map((m) => m.tag)).toEqual(
        readMigrations().map((m) => m.tag),
      );
      expect(store.tasks.get('t_1')?.project_id).toBe('p_1');
      expect(store.workspaces.findCurrentByTask('t_1')?.id).toBe('w_2');
      expect(pragma(store, 'foreign_keys')).toBe(1);
      const fks = store.connection.prepare("PRAGMA foreign_key_list('run')").all();
      expect(fks.map((f) => (f as { table: string }).table).sort()).toEqual(['task', 'workspace']);
    } finally {
      store.close();
    }
  });

  it('refuses to upgrade (and changes nothing) when existing rows break a new key', () => {
    rawInit([task('t_1', 'p_missing')]);
    expect(() => createSqliteStore({ path: dbPath })).toThrow(/task → project ×1/);
    const db = new DatabaseSync(dbPath);
    try {
      const tags = db.prepare('SELECT tag FROM migration').all() as { tag: string }[];
      expect(tags.map((t) => t.tag)).toEqual([readMigrations()[0]!.tag]);
      expect(db.prepare('SELECT count(*) AS n FROM task').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('refuses to upgrade when two non-removed workspaces share a task', () => {
    rawInit([PROJECT, task('t_1', 'p_1'), ws('w_1', 'active'), ws('w_2', 'kept')]);
    expect(() => createSqliteStore({ path: dbPath })).toThrow(/UNIQUE constraint failed/);
  });
});
