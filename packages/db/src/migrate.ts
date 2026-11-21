import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

/** drizzle-kit output (`packages/db/drizzle/`), resolved from this file in both src/ and dist/. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

/** Bookkeeping table: one row per applied migration. */
export const MIGRATION_TABLE = 'migration';

const BREAKPOINT = '--> statement-breakpoint';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface Migration {
  tag: string;
  /** drizzle-kit's `when` (ms since epoch). */
  createdAt: number;
  /** sha256 of the SQL file; an applied migration must never change. */
  hash: string;
  statements: string[];
}

export interface AppliedMigration {
  tag: string;
  hash: string;
  created_at: number;
  applied_at: string;
}

/** Read drizzle-kit's journal and SQL files, in journal order. */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const text = readFileSync(join(dir, `${entry.tag}.sql`), 'utf8');
      return {
        tag: entry.tag,
        createdAt: entry.when,
        hash: createHash('sha256').update(text).digest('hex'),
        statements: text
          .split(BREAKPOINT)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      };
    });
}

/**
 * Apply every migration not yet recorded in `migration`, in one `BEGIN IMMEDIATE` transaction
 * (so two processes opening the same file cannot both apply it). Refuses to run when an applied
 * migration was edited afterwards or the database has migrations this build does not know.
 * Returns the tags applied now.
 */
export function applyMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  const migrations = readMigrations(dir);
  const known = new Set(migrations.map((m) => m.tag));
  const appliedNow: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        tag TEXT PRIMARY KEY NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    );
    const rows = db.prepare(`SELECT tag, hash FROM ${MIGRATION_TABLE}`).all() as unknown as Pick<
      AppliedMigration,
      'tag' | 'hash'
    >[];
    const applied = new Map(rows.map((r) => [r.tag, r.hash]));
    const unknown = [...applied.keys()].filter((tag) => !known.has(tag));
    if (unknown.length > 0) {
      throw new Error(
        `database has migrations this build does not know (${unknown.join(', ')}); ` +
          'it was written by a newer version',
      );
    }
    const record = db.prepare(
      `INSERT INTO ${MIGRATION_TABLE} (tag, hash, created_at, applied_at) VALUES (?, ?, ?, ?)`,
    );
    for (const m of migrations) {
      const hash = applied.get(m.tag);
      if (hash !== undefined) {
        if (hash !== m.hash) {
          throw new Error(`migration ${m.tag} changed after it was applied (hash mismatch)`);
        }
        continue;
      }
      for (const statement of m.statements) db.exec(statement);
      record.run(m.tag, m.hash, m.createdAt, new Date().toISOString());
      appliedNow.push(m.tag);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  return appliedNow;
}

/** Rows of the bookkeeping table, oldest first. */
export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  return db
    .prepare(
      `SELECT tag, hash, created_at, applied_at FROM ${MIGRATION_TABLE} ORDER BY created_at, tag`,
    )
    .all() as unknown as AppliedMigration[];
}
