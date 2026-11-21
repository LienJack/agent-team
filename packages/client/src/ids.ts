// Random ids for Idempotency-Key and client_msg_id.
//
// `crypto.randomUUID()` only exists in secure contexts (https or localhost), but the board is
// opened over plain HTTP from other devices on the LAN (spec §11). `crypto.getRandomValues` is
// available in every context that has `crypto` at all; without it (very old or embedded
// runtimes) a non-crypto fallback still gives unique-enough keys — they only deduplicate
// retries, they are never secrets.

type RandomSource = Pick<Crypto, 'getRandomValues'>;

function fallbackBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const time = Date.now();
  for (let i = 0; i < bytes.length; i++) {
    // mix the clock into the first bytes so two runtimes started together still differ
    bytes[i] = (Math.floor(Math.random() * 256) ^ (i < 6 ? (time >>> (i * 8)) & 0xff : 0)) & 0xff;
  }
  return bytes;
}

function randomBytes(source: RandomSource | undefined): Uint8Array {
  if (source && typeof source.getRandomValues === 'function') {
    try {
      return source.getRandomValues(new Uint8Array(16));
    } catch {
      // some sandboxes expose crypto but refuse to use it
    }
  }
  return fallbackBytes();
}

/** RFC 4122 version 4 UUID from `getRandomValues` (or the non-crypto fallback). */
export function randomId(source: RandomSource | undefined = globalThis.crypto): string {
  const bytes = randomBytes(source);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
