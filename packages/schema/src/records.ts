import { z } from 'zod';
import {
  IsoDateTimeSchema,
  JsonValueSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  RunnerNameSchema,
} from './common.js';
import { OutboxIdSchema, RunIdSchema, TaskIdSchema, WorkspaceIdSchema } from './ids.js';
import { RunSpecSchema } from './runner.js';

// ------------------------------------------------------------------ effects

/** Side effects stored before they run (spec §1.3, §5 `effect`). */
export const EFFECT_KINDS = [
  'run.start',
  'run.stop',
  'run.verify',
  'workspace.remove',
  'workspace.rebuild',
  'outbox.send',
] as const;
export const EffectKindSchema = z.enum(EFFECT_KINDS);
export type EffectKind = z.infer<typeof EffectKindSchema>;

export const EffectPayloadSchemas = {
  /** Launch the run; key = run id. Ignored if the run is no longer `starting`/current. */
  'run.start': z.object({ run_id: RunIdSchema, spec: RunSpecSchema }),
  /** Abort an in-flight run; key = run id. */
  'run.stop': z.object({ run_id: RunIdSchema, reason: z.string() }),
  /** Verification steps 3–5 (diff, checks, commit); key = run id. */
  'run.verify': z.object({ run_id: RunIdSchema }),
  /** Remove a worktree directory (branch is kept); key = workspace id or path for orphans. */
  'workspace.remove': z.object({
    workspace_id: WorkspaceIdSchema.nullable(),
    repo_path: z.string().min(1),
    path: z.string().min(1),
    reason: z.enum(['cleanup', 'orphan']),
  }),
  /**
   * Discard a task's worktree and recreate it from the current base tip (base drift answer
   * "rebuild"); key = workspace id. The task is requeued as a fresh impl when it completes.
   */
  'workspace.rebuild': z.object({ task_id: TaskIdSchema, workspace_id: WorkspaceIdSchema }),
  /**
   * Deliver one outbox item; key = outbox id. Items of the same `lane` are delivered in order:
   * `reply:<grokmsg id>` for the replies to one Grok message, `notify:<task id or ->` for
   * proactive notices, so a failing notice never holds up a reply (no lane = legacy per-task).
   */
  'outbox.send': z.object({
    outbox_id: OutboxIdSchema,
    task_id: TaskIdSchema.nullable(),
    lane: z.string().min(1).max(300).optional(),
  }),
} as const satisfies Record<EffectKind, z.ZodType>;
export type EffectPayload<K extends EffectKind> = z.infer<(typeof EffectPayloadSchemas)[K]>;

/**
 * A stored side effect. PK (kind, key). `seq` orders execution; `generation` increments when the
 * same (kind, key) is enqueued again so a finishing executor only deletes the version it ran.
 */
export const EffectRecordSchema = z.object({
  kind: EffectKindSchema,
  key: z.string().min(1),
  payload: JsonValueSchema,
  seq: PositiveIntSchema,
  generation: PositiveIntSchema,
  attempts: NonNegativeIntSchema,
  /** Not before this time (ISO UTC; compared lexically). */
  due: IsoDateTimeSchema,
  error: z.string().nullable(),
});
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

// ------------------------------------------------------------------- outbox

/** Proactive notification kinds (spec §10). */
export const NotifyKindSchema = z.enum([
  'task_done',
  'task_failed',
  'attention',
  'task_blocked',
  'quota_exhausted',
  'no_receipt',
  'circuit_open',
  /** A reply to an inbound Grok message (`grokmsg reply`), written by the hub. */
  'reply',
]);
export type NotifyKind = z.infer<typeof NotifyKindSchema>;

export const OutboxStatusSchema = z.enum(['pending', 'sent', 'failed']);

export const OutboxItemSchema = z.object({
  id: OutboxIdSchema,
  target: z.enum(['grok']),
  kind: NotifyKindSchema,
  body: z.string(),
  /** Dedupe key; an item with the same signature is never sent twice (also across restarts). */
  signature: z.string().min(1),
  status: OutboxStatusSchema,
  task_id: TaskIdSchema.nullable(),
  attempts: NonNegativeIntSchema,
  error: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  sent_at: IsoDateTimeSchema.nullable(),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

// -------------------------------------------------------------- idempotency

/** Stored response of an idempotent request (replayed for the same key and payload). */
export const IdempotentResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: JsonValueSchema,
});
export type IdempotentResponse = z.infer<typeof IdempotentResponseSchema>;

export const IdempotencyRecordSchema = z.object({
  caller: z.string().min(1),
  request_id: z.string().min(1).max(200),
  method: z.string().min(1),
  /** sha256 hex of the canonical JSON payload. */
  payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['pending', 'completed']),
  response: IdempotentResponseSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

// ----------------------------------------------------------------------- kv

export const KvEntrySchema = z.object({ key: z.string().min(1), value: z.string() });
export type KvEntry = z.infer<typeof KvEntrySchema>;

// ------------------------------------------------------------ runner health

/**
 * Per-runner cooldown / circuit-breaker / quota state, stored in `kv` under
 * `runner_health:<runner>` as JSON (see `runnerHealthKey`).
 */
export const RunnerHealthSchema = z.object({
  runner: RunnerNameSchema,
  cooldown_until: IsoDateTimeSchema.nullable(),
  cooldown_reason: z.string().nullable(),
  /** Consecutive failed runs (rate limits and cancellations excluded). */
  consecutive_failures: NonNegativeIntSchema,
  circuit_open_until: IsoDateTimeSchema.nullable(),
  quota: z
    .object({
      utilization: z.number().min(0).max(1).nullable(),
      resets_at: IsoDateTimeSchema.nullable(),
      exhausted: z.boolean(),
      updated_at: IsoDateTimeSchema,
    })
    .nullable(),
});
export type RunnerHealth = z.infer<typeof RunnerHealthSchema>;

export function runnerHealthKey(runner: string): string {
  return `runner_health:${runner}`;
}

export const CircuitStateSchema = z.enum(['closed', 'open', 'half_open']);
export type CircuitState = z.infer<typeof CircuitStateSchema>;

/** Runner health plus live availability, as shown by `/quota` and `/state`. */
export const RunnerStatusSchema = RunnerHealthSchema.extend({
  available: z.boolean(),
  circuit: CircuitStateSchema,
});
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;
