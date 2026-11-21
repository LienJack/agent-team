import type { EffectRepository, EventRepository, MessageRepository } from '@agent-team/core';
import type { EffectRecord, EventRecord, Message } from '@agent-team/schema';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { effect, event, message } from '../schema/index.js';
import { changed, guardUnique, limitOf, nextSeq, whereAll, type RepoDeps } from './shared.js';

export function messageRepo({ db, atomic }: RepoDeps): MessageRepository {
  return {
    get: (id) => db.select().from(message).where(eq(message.id, id)).get(),
    findByClientMsgId: (channel, clientMsgId) =>
      db
        .select()
        .from(message)
        .where(and(eq(message.channel, channel), eq(message.client_msg_id, clientMsgId)))
        .get(),
    list(filter = {}) {
      return db
        .select()
        .from(message)
        .where(
          whereAll(
            filter.channel === undefined ? undefined : eq(message.channel, filter.channel),
            filter.afterSeq === undefined ? undefined : gt(message.seq, filter.afterSeq),
          ),
        )
        .orderBy(asc(message.seq))
        .limit(limitOf(filter.limit))
        .all();
    },
    insert(input) {
      // A savepoint: a duplicate also undoes the counter step, so nothing is stored.
      return atomic((): Message => {
        const row: Message = { ...input, seq: nextSeq(db, 'message') };
        return guardUnique('message', row, () => db.insert(message).values(row).returning().get());
      });
    },
    update: (row) =>
      guardUnique('message', row, () =>
        changed(db.update(message).set(row).where(eq(message.id, row.id)).run()),
      ),
  };
}

type EventRow = typeof event.$inferSelect;

/** A stored row as the `type`-discriminated record (data was written from the same union). */
const toEvent = (row: EventRow): EventRecord => row as EventRecord;

export function eventRepo({ db }: RepoDeps): EventRepository {
  return {
    append(input) {
      const row = db
        .insert(event)
        .values({
          ts: input.ts,
          type: input.type,
          task_id: input.task_id,
          run_id: input.run_id,
          data: input.data,
        })
        .returning()
        .get();
      return toEvent(row);
    },
    listAfter(afterSeq, limit) {
      return db
        .select()
        .from(event)
        .where(gt(event.seq, afterSeq))
        .orderBy(asc(event.seq))
        .limit(limitOf(limit))
        .all()
        .map(toEvent);
    },
    lastSeq() {
      const row = db
        .select({ seq: sql<number>`coalesce(max(${event.seq}), 0)` })
        .from(event)
        .get();
      return Number(row?.seq ?? 0);
    },
  };
}

export function effectRepo({ db, atomic }: RepoDeps): EffectRepository {
  const byKey = (kind: EffectRecord['kind'], key: string) =>
    and(eq(effect.kind, kind), eq(effect.key, key));
  const byGeneration = (kind: EffectRecord['kind'], key: string, generation: number) =>
    and(byKey(kind, key), eq(effect.generation, generation));
  const get = (kind: EffectRecord['kind'], key: string): EffectRecord | undefined =>
    db.select().from(effect).where(byKey(kind, key)).get();

  return {
    upsert(input) {
      return atomic((): EffectRecord => {
        const existing = get(input.kind, input.key);
        if (existing) {
          return db
            .update(effect)
            .set({
              payload: input.payload,
              due: input.due,
              generation: existing.generation + 1,
              attempts: 0,
              error: null,
            })
            .where(byKey(input.kind, input.key))
            .returning()
            .get()!;
        }
        const row: EffectRecord = {
          kind: input.kind,
          key: input.key,
          payload: input.payload,
          seq: nextSeq(db, 'effect'),
          generation: 1,
          attempts: 0,
          due: input.due,
          error: null,
        };
        return guardUnique('effect', row, () => db.insert(effect).values(row).returning().get());
      });
    },
    get,
    list: () => db.select().from(effect).orderBy(asc(effect.seq)).all(),
    listDue(now, limit) {
      return db
        .select()
        .from(effect)
        .where(lte(effect.due, now))
        .orderBy(asc(effect.seq))
        .limit(limitOf(limit))
        .all();
    },
    delete: (kind, key, generation) =>
      changed(
        db
          .delete(effect)
          .where(byGeneration(kind, key, generation))
          .run(),
      ),
    recordFailure: (kind, key, generation, failure) =>
      db
        .update(effect)
        .set({ attempts: failure.attempts, due: failure.due, error: failure.error })
        .where(byGeneration(kind, key, generation))
        .returning()
        .get(),
  };
}
