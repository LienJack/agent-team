import type {
  EffectRecord,
  EventRecord,
  IdempotencyRecord,
  JsonValue,
  Message,
  OutboxItem,
} from '@agent-team/schema';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Drizzle tables for the spec §5 logs and records, plus two internal tables (`counter`; the
// `migration` bookkeeping table is created by ../migrate.ts, not by drizzle-kit).

export const message = sqliteTable(
  'message',
  {
    id: text().primaryKey(),
    channel: text().$type<Message['channel']>().notNull(),
    direction: text().$type<Message['direction']>().notNull(),
    source: text().$type<Message['source']>().notNull(),
    body: text().notNull(),
    client_msg_id: text().notNull(),
    ref: text(),
    status: text().$type<Message['status']>().notNull(),
    /** Assigned from `counter` row `message` (increasing across channels, never reused). */
    seq: integer().notNull().unique(),
    created_at: text().notNull(),
  },
  (t) => [uniqueIndex('message_channel_client_msg_id_unique').on(t.channel, t.client_msg_id)],
);

/** Change log and SSE cursor: `seq` is AUTOINCREMENT, so values are never reused. */
export const event = sqliteTable(
  'event',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    ts: text().notNull(),
    type: text().$type<EventRecord['type']>().notNull(),
    task_id: text(),
    run_id: text(),
    data: text({ mode: 'json' }).$type<EventRecord['data']>().notNull(),
  },
  (t) => [index('event_task_idx').on(t.task_id)],
);

export const effect = sqliteTable(
  'effect',
  {
    kind: text().$type<EffectRecord['kind']>().notNull(),
    key: text().notNull(),
    /** JSON; SQL NULL stores the JSON value `null`. */
    payload: text({ mode: 'json' }).$type<JsonValue>(),
    /** Assigned from `counter` row `effect`; kept when (kind, key) is enqueued again. */
    seq: integer().notNull().unique(),
    generation: integer().notNull(),
    attempts: integer().notNull(),
    due: text().notNull(),
    error: text(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] }), index('effect_due_idx').on(t.due)],
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: text().primaryKey(),
    target: text().$type<OutboxItem['target']>().notNull(),
    kind: text().$type<OutboxItem['kind']>().notNull(),
    body: text().notNull(),
    signature: text().notNull().unique(),
    status: text().$type<OutboxItem['status']>().notNull(),
    task_id: text(),
    attempts: integer().notNull(),
    error: text(),
    created_at: text().notNull(),
    sent_at: text(),
  },
  (t) => [index('outbox_status_idx').on(t.status), index('outbox_task_idx').on(t.task_id)],
);

export const idempotency = sqliteTable(
  'idempotency',
  {
    caller: text().notNull(),
    request_id: text().notNull(),
    method: text().notNull(),
    payload_hash: text().notNull(),
    state: text().$type<IdempotencyRecord['state']>().notNull(),
    response: text({ mode: 'json' }).$type<NonNullable<IdempotencyRecord['response']>>(),
    created_at: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.caller, t.request_id] }),
    index('idempotency_state_idx').on(t.state),
  ],
);

export const kv = sqliteTable('kv', {
  key: text().primaryKey(),
  value: text().notNull(),
});

/** Internal monotonic sequences (`message`, `effect`); rolled back with the transaction. */
export const counter = sqliteTable('counter', {
  name: text().primaryKey(),
  value: integer().notNull(),
});
