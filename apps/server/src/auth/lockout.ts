import type { Clock } from '@agent-team/core';

interface Entry {
  failures: number;
  lockedUntil: number;
}

/**
 * Per-source login lockout (spec §11): `failures` consecutive wrong passwords lock the source
 * for `lockMs`. A success resets it. In memory (a restart clears it); bounded in size.
 */
export class Lockout {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly failures: number,
    private readonly lockMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  /** The ISO time the source is locked until, or undefined when it may try. */
  lockedUntil(source: string): string | undefined {
    const entry = this.entries.get(source);
    if (!entry || entry.lockedUntil === 0) return undefined;
    if (entry.lockedUntil <= this.clock.now().getTime()) {
      this.entries.delete(source);
      return undefined;
    }
    return new Date(entry.lockedUntil).toISOString();
  }

  /** Record a failed attempt; returns true when this failure locked the source. */
  fail(source: string): boolean {
    const entry = this.entries.get(source) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    const locked = entry.failures >= this.failures;
    if (locked) entry.lockedUntil = this.clock.now().getTime() + this.lockMs;
    this.entries.delete(source); // re-insert: Map order = least recently touched first
    this.entries.set(source, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return locked;
  }

  succeed(source: string): void {
    this.entries.delete(source);
  }
}
