// Random ids for Idempotency-Key and chat client_msg_id.
//
// `crypto.randomUUID()` only exists in secure contexts (https or localhost), but the board is
// opened over plain HTTP from other devices on the LAN (spec §11), so ids are built from
// `crypto.getRandomValues`, which every context has.

type RandomSource = Pick<Crypto, 'getRandomValues'>;

/** RFC 4122 version 4 UUID from `getRandomValues`. */
export function randomId(source: RandomSource = globalThis.crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
