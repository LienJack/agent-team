import { SqliteStore } from './store.js';

export interface SqliteStoreOptions {
  /** Path of the SQLite file (created with its parent directories if missing). */
  path: string;
}

/**
 * Open the SQLite database at `opts.path` (WAL, `busy_timeout=5000`, foreign keys on), apply
 * pending migrations from `packages/db/drizzle/` and return a synchronous `Store` over it
 * (`Store & { close(): void }`).
 */
export function createSqliteStore(opts: SqliteStoreOptions): SqliteStore {
  return SqliteStore.open(opts.path);
}

export { SqliteStore } from './store.js';
export { BUSY_TIMEOUT_MS, openDatabase, type OpenOptions } from './open.js';
export {
  applyMigrations,
  appliedMigrations,
  MIGRATION_TABLE,
  MIGRATIONS_DIR,
  readMigrations,
  type AppliedMigration,
  type Migration,
} from './migrate.js';
export * as tables from './schema/index.js';
