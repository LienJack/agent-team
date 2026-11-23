import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Both sides are hashed first so inputs of different lengths
 * take the same path (`timingSafeEqual` throws on unequal lengths).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** Random URL-safe token (`bytes` bytes of entropy). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
