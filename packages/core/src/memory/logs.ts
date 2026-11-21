import type {
  EffectKind,
  EffectRecord,
  EventRecord,
  IdempotencyRecord,
  KvEntry,
  Message,
  MessageChannel,
  NewEvent,
  NewMessage,
} from '@agent-team/schema';
import { UniqueViolationError } from '../errors.js';
import type {
  EffectInput,
  EffectRepository,
  EventRepository,
  IdempotencyRepository,
  KvRepository,
  MessageFilter,
  MessageRepository,
  OutboxFilter,
  OutboxRepository,
} from '../ports/repositories.js';
import { byCreated, byKeys, checkTaskRef, copy, type StateRef } from './state.js';

// In-memory repositories of the spec §5 logs and records (messages, events, effects, outbox,
// idempotency, kv).

export function messageRepo(s: StateRef): MessageRepository {
  const find = (channel: MessageChannel, clientMsgId: string) =>
    [...s().messages.values()].find(
      (m) => m.channel === channel && m.client_msg_id === clientMsgId,
    );
  return {
    get: (id) => copy(s().messages.get(id)),
    findByClientMsgId: (channel, clientMsgId) => copy(find(channel, clientMsgId)),
    list(filter: MessageFilter = {}) {
      const items = [...s().messages.values()]
        .filter(
          (m) =>
            (filter.channel === undefined || m.channel === filter.channel) &&
            (filter.afterSeq === undefined || m.seq > filter.afterSeq),
        )
        .sort((a, b) => a.seq - b.seq);
      return (filter.limit === undefined ? items : items.slice(0, filter.limit)).map(copy);
    },
    insert(message: NewMessage) {
      const st = s();
      if (st.messages.has(message.id)) {
        throw new UniqueViolationError('message', `id ${message.id}`);
      }
      if (find(message.channel, message.client_msg_id)) {
        throw new UniqueViolationError('message', `client_msg_id ${message.client_msg_id}`);
      }
      st.seq.message += 1;
      const stored: Message = { ...copy(message), seq: st.seq.message };
      st.messages.set(stored.id, stored);
      return copy(stored);
    },
    update(message) {
      if (!s().messages.has(message.id)) return false;
      s().messages.set(message.id, copy(message));
      return true;
    },
  };
}

export function eventRepo(s: StateRef): EventRepository {
  return {
    append(event: NewEvent) {
      const st = s();
      st.seq.event += 1;
      const stored = { ...copy(event), seq: st.seq.event } as EventRecord;
      st.events.push(stored);
      return copy(stored);
    },
    listAfter(afterSeq, limit) {
      const items = s().events.filter((e) => e.seq > afterSeq);
      return (limit === undefined ? items : items.slice(0, limit)).map(copy);
    },
    lastSeq: () => s().seq.event,
  };
}

const effectId = (kind: EffectKind, key: string) => `${kind}\u0000${key}`;

export function effectRepo(s: StateRef): EffectRepository {
  const sorted = () => [...s().effects.values()].sort((a, b) => a.seq - b.seq);
  return {
    upsert(input: EffectInput) {
      const st = s();
      const id = effectId(input.kind, input.key);
      const existing = st.effects.get(id);
      let stored: EffectRecord;
      if (existing) {
        stored = {
          ...existing,
          payload: copy(input.payload),
          due: input.due,
          generation: existing.generation + 1,
          attempts: 0,
          error: null,
        };
      } else {
        st.seq.effect += 1;
        stored = {
          kind: input.kind,
          key: input.key,
          payload: copy(input.payload),
          seq: st.seq.effect,
          generation: 1,
          attempts: 0,
          due: input.due,
          error: null,
        };
      }
      st.effects.set(id, stored);
      return copy(stored);
    },
    get: (kind, key) => copy(s().effects.get(effectId(kind, key))),
    list: () => sorted().map(copy),
    listDue(now, limit) {
      const items = sorted().filter((e) => e.due <= now);
      return (limit === undefined ? items : items.slice(0, limit)).map(copy);
    },
    delete(kind, key, generation) {
      const id = effectId(kind, key);
      const existing = s().effects.get(id);
      if (!existing || existing.generation !== generation) return false;
      s().effects.delete(id);
      return true;
    },
    recordFailure(kind, key, generation, failure) {
      const id = effectId(kind, key);
      const existing = s().effects.get(id);
      if (!existing || existing.generation !== generation) return undefined;
      const stored = { ...existing, ...failure };
      s().effects.set(id, stored);
      return copy(stored);
    },
  };
}

export function outboxRepo(s: StateRef): OutboxRepository {
  return {
    get: (id) => copy(s().outbox.get(id)),
    findBySignature: (signature) =>
      copy([...s().outbox.values()].find((o) => o.signature === signature)),
    list(filter: OutboxFilter = {}) {
      return [...s().outbox.values()]
        .filter(
          (o) =>
            (filter.task_id === undefined || o.task_id === filter.task_id) &&
            (filter.statuses === undefined || filter.statuses.includes(o.status)),
        )
        .sort(byCreated)
        .map(copy);
    },
    insert(item) {
      const m = s().outbox;
      if (m.has(item.id)) throw new UniqueViolationError('outbox', `id ${item.id}`);
      if ([...m.values()].some((o) => o.signature === item.signature)) {
        throw new UniqueViolationError('outbox', `signature ${item.signature}`);
      }
      checkTaskRef(s(), 'outbox', item);
      m.set(item.id, copy(item));
    },
    update(item) {
      if (!s().outbox.has(item.id)) return false;
      checkTaskRef(s(), 'outbox', item);
      s().outbox.set(item.id, copy(item));
      return true;
    },
  };
}

const idemId = (caller: string, requestId: string) => `${caller}\u0000${requestId}`;

export function idempotencyRepo(s: StateRef): IdempotencyRepository {
  return {
    get: (caller, requestId) => copy(s().idempotency.get(idemId(caller, requestId))),
    listByState(state) {
      return [...s().idempotency.values()]
        .filter((r) => r.state === state)
        .sort(
          byKeys<IdempotencyRecord>(
            (r) => r.created_at,
            (r) => r.caller,
            (r) => r.request_id,
          ),
        )
        .map(copy);
    },
    insert(record) {
      const id = idemId(record.caller, record.request_id);
      if (s().idempotency.has(id)) {
        throw new UniqueViolationError('idempotency', `${record.caller}/${record.request_id}`);
      }
      s().idempotency.set(id, copy(record));
    },
    update(record) {
      const id = idemId(record.caller, record.request_id);
      if (!s().idempotency.has(id)) return false;
      s().idempotency.set(id, copy(record));
      return true;
    },
    delete: (caller, requestId) => s().idempotency.delete(idemId(caller, requestId)),
  };
}

export function kvRepo(s: StateRef): KvRepository {
  return {
    get: (key) => s().kv.get(key),
    set: (key, value) => void s().kv.set(key, value),
    delete: (key) => s().kv.delete(key),
    list(prefix = '') {
      return [...s().kv.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]): KvEntry => ({ key, value }));
    },
  };
}
