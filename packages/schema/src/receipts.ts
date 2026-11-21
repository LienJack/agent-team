import { z } from 'zod';
import type { JsonSchema } from './common.js';

/** Max length of a receipt summary (spec §6: ≤600 字). */
export const RECEIPT_SUMMARY_MAX = 600;

export const CheckResultSchema = z.enum(['pass', 'fail', 'not_run']);

/**
 * Final answer of an impl/fix worker (spec §6). Every field is required so the same schema works
 * with the strictest structured-output dialect. `needs_leader` is `""` when nothing is needed.
 */
export const ImplReceiptSchema = z.object({
  dispatch_id: z.string().min(1),
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string().max(RECEIPT_SUMMARY_MAX),
  files_changed: z.array(z.string()),
  checks: z.array(
    z.object({
      cmd: z.string(),
      result: CheckResultSchema,
      note: z.string(),
    }),
  ),
  needs_leader: z.string(),
});
export type ImplReceipt = z.infer<typeof ImplReceiptSchema>;

export const FindingSeveritySchema = z.enum(['must_fix', 'should_fix', 'note']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const ReviewFindingSchema = z.object({
  file: z.string(),
  /** 1-based line; 0 when the finding is about the whole file. */
  line: z.number().int().min(0),
  severity: FindingSeveritySchema,
  issue: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** Final answer of a review worker (spec §6). */
export const ReviewReceiptSchema = z.object({
  dispatch_id: z.string().min(1),
  verdict: z.enum(['pass', 'needs_changes', 'blocked']),
  summary: z.string().max(RECEIPT_SUMMARY_MAX),
  findings: z.array(ReviewFindingSchema),
});
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;

export const ReceiptSchema = z.union([ImplReceiptSchema, ReviewReceiptSchema]);
export type Receipt = ImplReceipt | ReviewReceipt;

export type ReceiptKind = 'impl' | 'review';

export function receiptSchemaFor(kind: ReceiptKind) {
  return kind === 'impl' ? ImplReceiptSchema : ReviewReceiptSchema;
}

/**
 * Make an object JSON Schema maximally strict: every property required and
 * `additionalProperties: false`, recursively (OpenAI strict mode / claude `--json-schema`).
 */
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    out[key] = strictify(value);
  }
  if (out['type'] === 'object' && out['properties'] && typeof out['properties'] === 'object') {
    out['required'] = Object.keys(out['properties']);
    out['additionalProperties'] = false;
  }
  return out;
}

/**
 * JSON Schema of a receipt for runners' structured output (spec §6, §7). No `$schema` key,
 * every object has all properties required and `additionalProperties: false`.
 */
export function receiptJsonSchema(kind: ReceiptKind): JsonSchema {
  const raw = z.toJSONSchema(receiptSchemaFor(kind), { target: 'draft-2020-12', io: 'input' });
  return strictify(raw) as JsonSchema;
}

export type ParsedReceipt<K extends ReceiptKind> =
  | { ok: true; receipt: K extends 'impl' ? ImplReceipt : ReviewReceipt }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Forgive the slips of workers without enforced structured output (dsh), seen in the 2026-11-21
 * validation, each of which cost a whole fix round: an over-long `summary` is clipped to
 * `RECEIPT_SUMMARY_MAX`; a missing or null `needs_leader` is `""`; missing or null lists
 * (`files_changed`, `checks`, `findings`) are empty. Everything that decides the outcome
 * (`dispatch_id`, `status`, `verdict`, the findings themselves) is still validated strictly, and
 * files are verified against git anyway.
 */
export function normalizeReceipt(kind: ReceiptKind, value: unknown): unknown {
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  const summary = out['summary'];
  if (typeof summary === 'string' && summary.length > RECEIPT_SUMMARY_MAX) {
    out['summary'] = `${summary.slice(0, RECEIPT_SUMMARY_MAX - 1)}…`;
  }
  const lists = kind === 'impl' ? ['files_changed', 'checks'] : ['findings'];
  for (const key of lists) if (out[key] === undefined || out[key] === null) out[key] = [];
  if (kind === 'impl' && (out['needs_leader'] === undefined || out['needs_leader'] === null)) {
    out['needs_leader'] = '';
  }
  return out;
}

/** Validate a runner's `final` value as a receipt of `kind`; error is a short human message. */
export function parseReceipt<K extends ReceiptKind>(kind: K, value: unknown): ParsedReceipt<K> {
  const result = receiptSchemaFor(kind).safeParse(normalizeReceipt(kind, value));
  if (result.success) {
    return { ok: true, receipt: result.data } as ParsedReceipt<K>;
  }
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
