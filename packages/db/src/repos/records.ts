import type { IdempotencyRepository, KvRepository, OutboxRepository } from '@agent-team/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { idempotency, kv, outbox } from '../schema/index.js';
import { changed, guardUnique, whereAll, type RepoDeps } from './shared.js';

export function outboxRepo({ db }: RepoDeps): OutboxRepository {
  return {
    get: (id) => db.select().from(outbox).where(eq(outbox.id, id)).get(),
    findBySignature: (signature) =>
      db.select().from(outbox).where(eq(outbox.signature, signature)).get(),
    list(filter = {}) {
      if (filter.statuses?.length === 0) return [];
      return db
        .select()
        .from(outbox)
        .where(
          whereAll(
            filter.task_id === undefined ? undefined : eq(outbox.task_id, filter.task_id),
            filter.statuses === undefined
              ? undefined
              : inArray(outbox.status, [...filter.statuses]),
          ),
        )
        .orderBy(asc(outbox.created_at), asc(outbox.id))
        .all();
    },
    insert(row) {
      guardUnique('outbox', row, () => db.insert(outbox).values(row).run());
    },
    update: (row) =>
      guardUnique('outbox', row, () =>
        changed(db.update(outbox).set(row).where(eq(outbox.id, row.id)).run()),
      ),
  };
}

export function idempotencyRepo({ db }: RepoDeps): IdempotencyRepository {
  const byKey = (caller: string, requestId: string) =>
    and(eq(idempotency.caller, caller), eq(idempotency.request_id, requestId));
  return {
    get: (caller, requestId) => db.select().from(idempotency).where(byKey(caller, requestId)).get(),
    listByState: (state) =>
      db
        .select()
        .from(idempotency)
        .where(eq(idempotency.state, state))
        .orderBy(asc(idempotency.created_at), asc(idempotency.caller), asc(idempotency.request_id))
        .all(),
    insert(row) {
      guardUnique('idempotency', row, () => db.insert(idempotency).values(row).run());
    },
    update: (row) =>
      changed(db.update(idempotency).set(row).where(byKey(row.caller, row.request_id)).run()),
    delete: (caller, requestId) =>
      changed(db.delete(idempotency).where(byKey(caller, requestId)).run()),
  };
}

export function kvRepo({ db }: RepoDeps): KvRepository {
  return {
    get: (key) => db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get()?.value,
    set(key, value) {
      db.insert(kv)
        .values({ key, value })
        .onConflictDoUpdate({ target: kv.key, set: { value } })
        .run();
    },
    delete: (key) => changed(db.delete(kv).where(eq(kv.key, key)).run()),
    list(prefix = '') {
      // Not LIKE: `_` is a wildcard there and LIKE ignores ASCII case.
      return db
        .select({ key: kv.key, value: kv.value })
        .from(kv)
        .where(sql`substr(${kv.key}, 1, length(${prefix})) = ${prefix}`)
        .orderBy(asc(kv.key))
        .all();
    },
  };
}
