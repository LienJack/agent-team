import type {
  DatabaseSync,
  SQLInputValue,
  StatementResultingChanges,
  StatementSync,
} from 'node:sqlite';
import * as orm from 'drizzle-orm';
import { fillPlaceholders, type Query } from 'drizzle-orm';
import {
  BaseSQLiteDatabase,
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteSyncDialect,
  type SelectedFieldsOrdered,
  type SQLiteExecuteMethod,
} from 'drizzle-orm/sqlite-core';

// A minimal synchronous Drizzle driver over Node's built-in `node:sqlite` (`DatabaseSync`).
// drizzle-orm 0.45.4 ships no node:sqlite driver and its sqlite-proxy is async-only, so this
// mirrors drizzle-orm/better-sqlite3/session.js (`setReturnArrays` replaces better-sqlite3's
// `.raw()`). Transactions are owned by `SqliteStore.atomic()`, not by Drizzle. See docs/adr/0007.

type Row = Record<string, unknown>;
type RowMapper = (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown;
type Fields = SelectedFieldsOrdered;
type MapResultRow = (
  fields: Fields,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined,
) => unknown;

// `mapResultRow` is exported at runtime but marked @internal in drizzle-orm's typings; every
// bundled driver uses it to turn array rows into decoded objects (JSON columns, numbers, …).
const { mapResultRow } = orm as unknown as { mapResultRow: MapResultRow };

/** Prepared statements are reused per SQL text; the cache is cleared when it grows too large. */
const STATEMENT_CACHE_LIMIT = 256;

export type RunResult = StatementResultingChanges;

class NodeSqlitePreparedQuery extends SQLitePreparedQuery<{
  type: 'sync';
  run: RunResult;
  all: unknown;
  get: unknown;
  values: unknown[][];
  execute: unknown;
}> {
  /** Set by Drizzle's select builder for joins (read by `mapResultRow`). */
  declare joinsNotNullableMap: Record<string, boolean> | undefined;

  constructor(
    private readonly stmt: StatementSync,
    query: Query,
    private readonly fields: Fields | undefined,
    executeMethod: SQLiteExecuteMethod,
    private readonly customResultMapper: RowMapper | undefined,
  ) {
    super('sync', executeMethod, query);
  }

  private params(placeholderValues: Record<string, unknown> | undefined): SQLInputValue[] {
    return fillPlaceholders(this.query.params, placeholderValues ?? {}) as SQLInputValue[];
  }

  run(placeholderValues?: Record<string, unknown>): RunResult {
    this.stmt.setReturnArrays(false);
    return this.stmt.run(...this.params(placeholderValues));
  }

  all(placeholderValues?: Record<string, unknown>): unknown {
    if (!this.fields && !this.customResultMapper) {
      this.stmt.setReturnArrays(false);
      return this.stmt.all(...this.params(placeholderValues)) as Row[];
    }
    const rows = this.values(placeholderValues);
    if (this.customResultMapper) return this.customResultMapper(rows);
    const fields = this.fields!;
    return rows.map((row) => mapResultRow(fields, row, this.joinsNotNullableMap));
  }

  get(placeholderValues?: Record<string, unknown>): unknown {
    const params = this.params(placeholderValues);
    if (!this.fields && !this.customResultMapper) {
      this.stmt.setReturnArrays(false);
      return this.stmt.get(...params) as Row | undefined;
    }
    this.stmt.setReturnArrays(true);
    const row = this.stmt.get(...params) as unknown as unknown[] | undefined;
    if (!row) return undefined;
    if (this.customResultMapper) return this.customResultMapper([row]);
    return mapResultRow(this.fields!, row, this.joinsNotNullableMap);
  }

  values(placeholderValues?: Record<string, unknown>): unknown[][] {
    this.stmt.setReturnArrays(true);
    return this.stmt.all(...this.params(placeholderValues)) as unknown as unknown[][];
  }
}

class NodeSqliteSession extends SQLiteSession<'sync', RunResult, Record<string, never>, never> {
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    private readonly client: DatabaseSync,
    dialect: SQLiteSyncDialect,
  ) {
    super(dialect);
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      if (this.statements.size >= STATEMENT_CACHE_LIMIT) this.statements.clear();
      stmt = this.client.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  prepareQuery(
    query: Query,
    fields: Fields | undefined,
    executeMethod: SQLiteExecuteMethod,
    _isResponseInArrayMode: boolean,
    customResultMapper?: RowMapper,
  ): NodeSqlitePreparedQuery {
    return new NodeSqlitePreparedQuery(
      this.statement(query.sql),
      query,
      fields,
      executeMethod,
      customResultMapper,
    );
  }

  transaction(): never {
    throw new Error('use SqliteStore.atomic() for transactions');
  }
}

/** Synchronous Drizzle database over a `DatabaseSync` connection. */
export type NodeSqliteDatabase = BaseSQLiteDatabase<'sync', RunResult>;

export function drizzleNodeSqlite(client: DatabaseSync): NodeSqliteDatabase {
  const dialect = new SQLiteSyncDialect();
  const session = new NodeSqliteSession(client, dialect);
  return new BaseSQLiteDatabase('sync', dialect, session, undefined);
}
