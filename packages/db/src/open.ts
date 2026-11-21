import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, MIGRATIONS_DIR } from './migrate.js';

/** spec §2: WAL and `busy_timeout=5000`; foreign keys on. */
export const BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  /** Migration folder (default: packages/db/drizzle). Tests only. */
  migrationsDir?: string;
}

const IN_MEMORY = ':memory:';

/**
 * Open (creating parent directories and the file if needed) a connection, set the connection
 * pragmas outside any transaction, then apply pending migrations. `path` is a file path or
 * `:memory:` (no WAL).
 */
export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA foreign_keys = ON');
    if (path !== IN_MEMORY) {
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: unknown };
      if (row.journal_mode !== 'wal') {
        throw new Error(
          `could not enable WAL on ${path} (journal_mode=${String(row.journal_mode)})`,
        );
      }
    }
    applyMigrations(db, options.migrationsDir ?? MIGRATIONS_DIR);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
