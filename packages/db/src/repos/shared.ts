import { ForeignKeyViolationError, UniqueViolationError } from '@agent-team/core';
import { and, sql, type SQL } from 'drizzle-orm';
import type { NodeSqliteDatabase } from '../driver/node-sqlite.js';
import { counter } from '../schema/index.js';

export type Db = NodeSqliteDatabase;

/** Runs `fn` atomically (a transaction, or a savepoint inside one): `SqliteStore.atomic`. */
export type Atomic = <T>(fn: () => T) => T;

export interface RepoDeps {
  db: Db;
  atomic: Atomic;
}

// Extended result codes (https://sqlite.org/rescode.html).
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const MAX_CAUSE_DEPTH = 8;

/** The node:sqlite error behind `err` (Drizzle may wrap it in `cause`), if any. */
function sqliteError(err: unknown): { errcode: number; message: string } | undefined {
  let current: unknown = err;
  for (let i = 0; i < MAX_CAUSE_DEPTH && current != null; i++) {
    if (
      typeof current === 'object' &&
      typeof (current as { errcode?: unknown }).errcode === 'number'
    ) {
      return current as { errcode: number; message: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  const code = sqliteError(err)?.errcode;
  return code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return sqliteError(err)?.errcode === SQLITE_CONSTRAINT_FOREIGNKEY;
}

/** Columns named by SQLite's "UNIQUE constraint failed: t.a, t.b" message. */
function failedColumns(err: unknown): string[] {
  const message = sqliteError(err)?.message ?? '';
  const list = /constraint failed: (.+)$/.exec(message)?.[1];
  if (!list) return [];
  return list.split(',').map((c) => c.trim().split('.').pop() ?? c.trim());
}

/**
 * Run a write and turn constraint failures into the contract's errors: a unique/primary-key
 * conflict (including the partial "one non-removed workspace per task" index) into
 * `UniqueViolationError`, a foreign key into `ForeignKeyViolationError` (SQLite does not say
 * which one). The statement is undone by SQLite; an enclosing transaction stays usable.
 */
export function guardUnique<T>(entity: string, row: object, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new ForeignKeyViolationError(entity, 'parent row');
    if (!isUniqueViolation(err)) throw err;
    const values = row as Record<string, unknown>;
    const columns = failedColumns(err);
    const key =
      columns.length > 0 ? columns.map((c) => `${c} ${String(values[c])}`).join(', ') : 'key';
    throw new UniqueViolationError(entity, key);
  }
}

/** Next value of an internal sequence (1, 2, 3, …); part of the caller's transaction. */
export function nextSeq(db: Db, name: string): number {
  const row = db
    .insert(counter)
    .values({ name, value: 1 })
    .onConflictDoUpdate({ target: counter.name, set: { value: sql`${counter.value} + 1` } })
    .returning({ value: counter.value })
    .get();
  return row.value;
}

/** AND of the defined conditions (undefined = no filter). */
export function whereAll(...conditions: (SQL | undefined)[]): SQL | undefined {
  return and(...conditions);
}

/** `LIMIT -1` is SQLite's "no limit". */
export function limitOf(limit: number | undefined): number {
  return limit === undefined ? -1 : limit;
}

/** `changes` of a write as a number. */
export function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}
