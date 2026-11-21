import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A readable random password such as `k7mp-2qx9-a4hz-rt8c` (~79 bits). */
export function generatePassword(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  }
  return out;
}

export function hmac(key: Uint8Array, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

/** Short stable hash used where an identifier must not be stored verbatim (idempotency caller). */
export function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}
