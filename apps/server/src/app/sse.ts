import type { EventPublisher, Store } from '@agent-team/core';
import type { EventRecord, ServerConnectedFrame } from '@agent-team/schema';

// GET /api/events (spec §11): first frame `server.connected`, replay from the durable event
// table after the cursor, then live events; a heartbeat comment every `heartbeat_ms`; each
// connection has a bounded queue and is closed (only it) when the queue overflows.

/** One live connection's queue of committed events. */
export class Subscriber {
  private queue: EventRecord[] = [];
  private waiter: (() => void) | undefined;
  closed = false;
  overflowed = false;
  private readonly closeListeners: Array<() => void> = [];

  constructor(private readonly maxQueue: number) {}

  push(events: readonly EventRecord[]): void {
    if (this.closed) return;
    this.queue.push(...events);
    if (this.queue.length > this.maxQueue) {
      this.overflowed = true;
      this.close();
      return;
    }
    this.wake();
  }

  /** Next batch of queued events; null once closed. */
  async next(): Promise<EventRecord[] | null> {
    while (this.queue.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    if (this.closed) return null;
    const batch = this.queue;
    this.queue = [];
    return batch;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.wake();
    for (const listener of this.closeListeners) listener();
  }

  /** Run `listener` once when the subscriber closes (overflow or explicit). */
  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}

/** The engine's `EventPublisher`: fans committed events out to every SSE connection. */
export class EventHub implements EventPublisher {
  private readonly subscribers = new Set<Subscriber>();

  publish(events: readonly EventRecord[]): void {
    for (const sub of this.subscribers) sub.push(events);
  }

  subscribe(maxQueue: number): Subscriber {
    const sub = new Subscriber(maxQueue);
    this.subscribers.add(sub);
    sub.onClose(() => this.subscribers.delete(sub));
    return sub;
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Close every connection (service shutdown). */
  closeAll(): void {
    for (const sub of this.subscribers) sub.close();
  }
}

export interface EventStreamInput {
  store: Store;
  hub: EventHub;
  now: () => Date;
  /** Replay events with seq > after; undefined = only new events. */
  after: number | undefined;
  heartbeatMs: number;
  maxQueue: number;
  pageSize?: number;
}

const encoder = new TextEncoder();
const frame = (data: unknown, id?: number) =>
  encoder.encode(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);

/**
 * The SSE body. Subscribes before reading the replay so nothing committed in between is lost;
 * live events at or below the replayed cursor are dropped (no duplicates). Pull-based, so a slow
 * client stops the replay instead of buffering it; live events wait in the bounded queue.
 */
export function eventStream(input: EventStreamInput): ReadableStream<Uint8Array> {
  const sub = input.hub.subscribe(input.maxQueue);
  const lastSeq = input.store.events.lastSeq();
  // a cursor past the end (e.g. a reset database) restarts from the current end
  let cursor = input.after === undefined ? lastSeq : Math.min(input.after, lastSeq);
  let replaying = input.after !== undefined && cursor < lastSeq;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const pageSize = input.pageSize ?? 200;

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    sub.close();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const connected: ServerConnectedFrame = {
          type: 'server.connected',
          last_seq: lastSeq,
          ts: input.now().toISOString(),
        };
        controller.enqueue(frame(connected));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: heartbeat ${input.now().toISOString()}\n\n`));
          } catch {
            cleanup();
          }
        }, input.heartbeatMs);
        sub.onClose(() => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          try {
            if (sub.overflowed) controller.error(new Error('event queue overflow'));
            else controller.close();
          } catch {
            // already closed or cancelled
          }
        });
      },
      async pull(controller) {
        if (replaying) {
          const page = input.store.events.listAfter(cursor, pageSize);
          for (const event of page) controller.enqueue(frame(event, event.seq));
          if (page.length > 0) cursor = page[page.length - 1]!.seq;
          if (page.length < pageSize) replaying = false;
          if (page.length > 0) return;
        }
        for (;;) {
          const batch = await sub.next();
          if (batch === null) return; // onClose already closed/errored the stream
          const fresh = batch.filter((e) => e.seq > cursor);
          if (fresh.length === 0) continue;
          for (const event of fresh) controller.enqueue(frame(event, event.seq));
          cursor = fresh[fresh.length - 1]!.seq;
          return;
        }
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 1 },
  );
}
