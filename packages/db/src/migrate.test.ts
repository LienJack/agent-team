import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
});
