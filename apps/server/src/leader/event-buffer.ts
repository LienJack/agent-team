import type { EventRecord } from '@agent-team/schema';

/**
 * Engine events waiting for the leader's next digest turn (spec §9 服務端合併後的事件批次).
 * A digest is due once no relevant event arrived for `windowMs` (a quiet window: tasks finishing
 * a few seconds apart become ONE digest — validation 2026-11-21 had three digests for three
 * tasks), but never later than `maxWaitMs` after the oldest buffered event, and at once when
 * `maxBatch` events are waiting. One digest takes at most `maxBatch` events (the oldest); the
 * rest are due right after it. Bounded: beyond `max` the oldest are dropped first.
 */
export class EventBuffer {
  private list: EventRecord[] = [];
  /** When the oldest buffered event arrived. */
  private since: number | undefined;
  /** When the newest relevant event arrived. */
  private last: number | undefined;
  /** Highest seq of any committed batch seen (relevant or not). */
  seenSeq = 0;
  private readonly maxWaitMs: number;
  private readonly maxBatch: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(
    private readonly windowMs: number,
    opts: { maxWaitMs?: number; maxBatch?: number; max?: number; now?: () => number } = {},
  ) {
    this.maxWaitMs = Math.max(windowMs, opts.maxWaitMs ?? windowMs);
    this.maxBatch = Math.max(1, opts.maxBatch ?? 30);
    this.max = opts.max ?? 500;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.list.length;
  }

  /** Startup: the relevant events after the leader's cursor, and the store's last seq. */
  load(events: readonly EventRecord[], lastSeq: number): void {
    this.seenSeq = lastSeq;
    this.list = events.slice(-this.max);
    const at = this.list.length > 0 ? this.now() : undefined;
    this.since = at;
    this.last = at;
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
      added = true;
    }
    if (added) {
      const at = this.now();
      this.since ??= at;
      this.last = at;
    }
    return added;
  }

  /** Milliseconds until the next digest is due (0 = now). */
  waitMs(): number {
    if (this.list.length === 0) return 0;
    if (this.list.length >= this.maxBatch) return 0;
    const now = this.now();
    const quiet = (this.last ?? now) + this.windowMs;
    const cap = (this.since ?? now) + this.maxWaitMs;
    return Math.max(0, Math.min(quiet, cap) - now);
  }

  /** The oldest `maxBatch` buffered events, for one digest turn; the rest stay due. */
  take(): EventRecord[] {
    const out = this.list.slice(0, this.maxBatch);
    this.list = this.list.slice(out.length);
    if (this.list.length === 0) {
      this.since = undefined;
      this.last = undefined;
    } else {
      this.since = this.now() - this.maxWaitMs; // they have waited already: due right away
    }
    return out;
  }

  /** A digest whose turn did not run goes back in front, due at once. */
  putBack(events: readonly EventRecord[]): void {
    this.list = [...events, ...this.list];
    const at = this.now();
    this.since = at - this.maxWaitMs;
    this.last ??= at;
  }
}
