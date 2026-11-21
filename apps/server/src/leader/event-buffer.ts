import type { EventRecord } from '@agent-team/schema';

/**
 * Engine events waiting for the leader's next digest turn (spec §9 服務端合併後的事件批次): the
 * events of one `event_window_ms` window become one turn. Bounded: the oldest are dropped first.
 */
export class EventBuffer {
  private list: EventRecord[] = [];
  /** `Date.now()` when the oldest buffered event arrived. */
  private since: number | undefined;
  /** Highest seq of any committed batch seen (relevant or not). */
  seenSeq = 0;

  constructor(
    private readonly windowMs: number,
    private readonly max = 500,
  ) {}

  get size(): number {
    return this.list.length;
  }

  /** Startup: the relevant events after the leader's cursor, and the store's last seq. */
  load(events: readonly EventRecord[], lastSeq: number): void {
    this.seenSeq = lastSeq;
    this.list = events.slice(-this.max);
    this.since = this.list.length > 0 ? Date.now() : undefined;
  }

  /** Add the relevant new events of a committed batch; true when anything was added. */
  add(batch: readonly EventRecord[], relevant: (event: EventRecord) => boolean): boolean {
    let added = false;
    for (const event of batch) {
      if (event.seq <= this.seenSeq) continue;
      this.seenSeq = event.seq;
      if (!relevant(event)) continue;
      this.list.push(event);
      if (this.list.length > this.max) this.list.shift();
      this.since ??= Date.now();
      added = true;
    }
    return added;
  }

  /** Milliseconds until the window of the oldest buffered event closes (0 = a digest is due). */
  waitMs(): number {
    return Math.max(0, (this.since ?? 0) + this.windowMs - Date.now());
  }

  /** Everything buffered, for one digest turn. */
  take(): EventRecord[] {
    const out = this.list;
    this.list = [];
    this.since = undefined;
    return out;
  }

  /** A digest whose turn did not run goes back in front, due at once. */
  putBack(events: readonly EventRecord[]): void {
    this.list = [...events, ...this.list];
    this.since = Date.now() - this.windowMs;
  }
}
