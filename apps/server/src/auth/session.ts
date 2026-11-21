import { randomBytes } from 'node:crypto';
import type { Clock } from '@agent-team/core';
import { constantTimeEqual, hmac, randomToken } from './secrets.js';

/**
 * HMAC-signed LAN session cookies: `<sid>.<expires_ms>.<mac>`. The key is random per process
 * start (secrets never go into the database), so a restart logs everyone out.
 */
export class SessionSigner {
  private readonly key: Uint8Array;

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    key?: Uint8Array,
  ) {
    this.key = key ?? randomBytes(32);
  }

  issue(): { value: string; sid: string; maxAgeSeconds: number } {
    const sid = randomToken(16);
    const expires = this.clock.now().getTime() + this.ttlMs;
    const payload = `${sid}.${expires}`;
    return {
      value: `${payload}.${hmac(this.key, payload)}`,
      sid,
      maxAgeSeconds: Math.floor(this.ttlMs / 1000),
    };
  }

  /** The session id of a valid, unexpired cookie value; undefined otherwise. */
  verify(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const parts = value.split('.');
    if (parts.length !== 3) return undefined;
    const [sid, expires, mac] = parts as [string, string, string];
    if (!/^\d+$/.test(expires)) return undefined;
    if (!constantTimeEqual(mac, hmac(this.key, `${sid}.${expires}`))) return undefined;
    if (Number(expires) <= this.clock.now().getTime()) return undefined;
    return sid;
  }
}
