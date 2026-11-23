import { z } from 'zod';

/**
 * Id prefixes (spec §5). `dispatch`, `outbox` and `note` are not named in the spec; they use `d_`,
 * `o_` and `n_`.
 * An id is `<prefix><random>` where random is lowercase base32 (Crockford alphabet, no i/l/o/u).
 */
export const ID_PREFIXES = {
  project: 'p_',
  task: 't_',
  workspace: 'w_',
  run: 'r_',
  attention: 'a_',
  message: 'm_',
  dispatch: 'd_',
  outbox: 'o_',
  /** A note a person added to a project's memory (`team memory add`; spec §18). */
  note: 'n_',
  /** One in-memory gate job (`POST /api/gate`; spec §19). */
  gate: 'g_',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** Length of the random part produced by {@link newId} (60 bits). */
export const ID_RANDOM_LENGTH = 12;

const idSchema = (kind: IdKind) =>
  z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}[0-9a-z]{1,32}$`), `expected a ${kind} id`);

export const ProjectIdSchema = idSchema('project');
export const TaskIdSchema = idSchema('task');
export const WorkspaceIdSchema = idSchema('workspace');
export const RunIdSchema = idSchema('run');
export const AttentionIdSchema = idSchema('attention');
export const MessageIdSchema = idSchema('message');
export const DispatchIdSchema = idSchema('dispatch');
export const OutboxIdSchema = idSchema('outbox');
export const NoteIdSchema = idSchema('note');
export const GateIdSchema = idSchema('gate');

interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function webCrypto(): RandomSource {
  const source = (globalThis as { crypto?: RandomSource }).crypto;
  if (!source) throw new Error('globalThis.crypto.getRandomValues is not available');
  return source;
}

/** Random id for `kind`, e.g. `newId('task')` → `t_8m3k0q2v9xab`. Uses Web Crypto (no IO). */
export function newId(kind: IdKind): string {
  const bytes = webCrypto().getRandomValues(new Uint8Array(ID_RANDOM_LENGTH));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return `${ID_PREFIXES[kind]}${out}`;
}

/** True when `id` has the prefix of `kind`. */
export function isIdOf(kind: IdKind, id: string): boolean {
  return idSchema(kind).safeParse(id).success;
}
