import { z } from 'zod';
import {
  IsoDateTimeSchema,
  MessageSourceSchema,
  ModelAliasSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  RoleNameSchema,
  RunnerNameSchema,
  ShaSchema,
} from './common.js';
import {
  AnswerViaSchema,
  AttentionKindSchema,
  MessageChannelSchema,
  MessageStatusSchema,
} from './domain.js';
import { AttentionIdSchema, MessageIdSchema, OutboxIdSchema, WorkspaceIdSchema } from './ids.js';
import { EffectKindSchema, NotifyKindSchema } from './records.js';
import { UsageSchema } from './runner.js';
import { RunKindSchema, RunOutcomeSchema, RunStateSchema, TaskStatusSchema } from './status.js';

const nullableString = z.string().nullable();

/**
 * Data payload of every event type the engine writes (spec §8: one event per state change).
 * The event table is the change log and the SSE cursor (`seq`).
 */
export const EVENT_DATA_SCHEMAS = {
  'project.created': z.object({ name: z.string() }),

  'task.created': z.object({ title: z.string(), status: TaskStatusSchema }),
  /** Non-status field changes (names only). */
  'task.updated': z.object({ fields: z.array(z.string()) }),
  'task.status_changed': z.object({
    from: TaskStatusSchema,
    to: TaskStatusSchema,
    reason: nullableString,
  }),
  'task.escalated': z.object({
    from_role: RoleNameSchema,
    to_role: RoleNameSchema,
    fix_rounds: NonNegativeIntSchema,
  }),
  'task.dispatch_failed': z.object({
    reason: z.string(),
    attempts: NonNegativeIntSchema,
    retry_at: IsoDateTimeSchema.nullable(),
  }),
  'task.base_drift': z.object({
    action: z.enum(['rebuilt', 'blocked']),
    base_sha: ShaSchema,
    new_base_sha: ShaSchema,
    files: z.array(z.string()),
  }),

  'workspace.created': z.object({
    workspace_id: WorkspaceIdSchema,
    path: z.string(),
    branch: z.string(),
    base_sha: ShaSchema,
  }),
  'workspace.rebased': z.object({ workspace_id: WorkspaceIdSchema, base_sha: ShaSchema }),
  /** Field changes of a workspace (state, head_sha, …), names only. */
  'workspace.updated': z.object({ workspace_id: WorkspaceIdSchema, fields: z.array(z.string()) }),
  'workspace.removed': z.object({
    workspace_id: WorkspaceIdSchema.nullable(),
    path: z.string(),
    reason: z.enum(['cleanup', 'orphan']),
  }),
  /** Removal found uncommitted changes: nothing was removed (docs/adr/0009). */
  'workspace.kept': z.object({
    workspace_id: WorkspaceIdSchema.nullable(),
    path: z.string(),
    reason: z.enum(['dirty']),
    changes: NonNegativeIntSchema,
  }),

  'run.created': z.object({
    kind: RunKindSchema,
    role: RoleNameSchema,
    model_alias: ModelAliasSchema,
    runner: RunnerNameSchema,
    model: z.string(),
    dispatch_id: z.string(),
  }),
  /** Dispatch outcome of a started attempt (`deferred` never creates a run, so no event). */
  'run.dispatched': z.object({
    outcome: z.enum(['accepted', 'rejected', 'unknown']),
    reason: nullableString,
  }),
  'run.state_changed': z.object({ from: RunStateSchema, to: RunStateSchema }),
  'run.finished': z.object({
    state: RunStateSchema,
    outcome: RunOutcomeSchema.nullable(),
    reject_reason: nullableString,
    error: nullableString,
    usage: UsageSchema.nullable(),
    cost_usd: z.number().nullable(),
  }),
  'run.verified': z.object({
    outcome: z.enum(['ok', 'rejected']),
    reject_reason: nullableString,
    checks: z.array(z.object({ name: z.string(), passed: z.boolean() })),
  }),
  'commit.created': z.object({
    workspace_id: WorkspaceIdSchema,
    sha: ShaSchema,
    message: z.string(),
  }),
  'review.completed': z.object({
    verdict: z.enum(['pass', 'needs_changes', 'blocked']),
    must_fix: NonNegativeIntSchema,
    findings: NonNegativeIntSchema,
  }),

  'attention.opened': z.object({
    attention_id: AttentionIdSchema,
    kind: AttentionKindSchema,
    question: z.string(),
    options: z.array(z.string()),
  }),
  'attention.answered': z.object({
    attention_id: AttentionIdSchema,
    answer: z.string(),
    via: AnswerViaSchema,
  }),
  'attention.superseded': z.object({ attention_id: AttentionIdSchema }),

  'message.created': z.object({
    message_id: MessageIdSchema,
    channel: MessageChannelSchema,
    direction: z.enum(['in', 'out']),
    source: MessageSourceSchema,
  }),
  'message.status_changed': z.object({ message_id: MessageIdSchema, status: MessageStatusSchema }),

  /** The leader answered an input (spec §9); the reply is stored as an outgoing message. */
  'leader.reply': z.object({
    message_id: MessageIdSchema,
    in_reply_to: MessageIdSchema,
    channel: MessageChannelSchema,
  }),
  /** Leader availability changed (rate limit, login, reset, back to normal). */
  'leader.status_changed': z.object({
    available: z.boolean(),
    reason: nullableString,
    until: IsoDateTimeSchema.nullable(),
  }),

  'runner.cooldown': z.object({
    runner: RunnerNameSchema,
    until: IsoDateTimeSchema,
    reason: z.string(),
  }),
  'runner.quota': z.object({
    runner: RunnerNameSchema,
    utilization: z.number().nullable(),
    resets_at: IsoDateTimeSchema.nullable(),
    exhausted: z.boolean(),
  }),
  'runner.circuit_opened': z.object({
    runner: RunnerNameSchema,
    failures: PositiveIntSchema,
    until: IsoDateTimeSchema,
  }),
  'runner.circuit_closed': z.object({ runner: RunnerNameSchema }),

  'effect.failed': z.object({
    kind: EffectKindSchema,
    key: z.string(),
    attempts: PositiveIntSchema,
    error: z.string(),
    next_due: IsoDateTimeSchema,
  }),
  'effect.dead': z.object({
    kind: EffectKindSchema,
    key: z.string(),
    attempts: PositiveIntSchema,
    error: z.string(),
  }),

  'outbox.queued': z.object({
    outbox_id: OutboxIdSchema,
    kind: NotifyKindSchema,
    signature: z.string(),
  }),
  'outbox.sent': z.object({ outbox_id: OutboxIdSchema }),
  'outbox.failed': z.object({ outbox_id: OutboxIdSchema, error: z.string() }),

  'recovery.completed': z.object({
    abandoned_runs: z.array(z.string()),
    requeued_tasks: z.array(z.string()),
    orphan_worktrees: NonNegativeIntSchema,
    pending_effects: NonNegativeIntSchema,
    cleared_idempotency: NonNegativeIntSchema,
  }),
} as const;

export type EventType = keyof typeof EVENT_DATA_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_DATA_SCHEMAS) as EventType[];
export type EventData<T extends EventType> = z.infer<(typeof EVENT_DATA_SCHEMAS)[T]>;

/** `{ type, data }` discriminated on `type`. */
export type TeamEvent = { [T in EventType]: { type: T; data: EventData<T> } }[EventType];

/** Columns every stored event has (spec §5 `event`). */
export interface EventEnvelope {
  seq: number;
  ts: string;
  task_id: string | null;
  run_id: string | null;
}
export type EventRecord = TeamEvent & EventEnvelope;
/** An event before the repository assigns `seq`. */
export type NewEvent = TeamEvent & Omit<EventEnvelope, 'seq'>;

const envelope = {
  seq: PositiveIntSchema,
  ts: IsoDateTimeSchema,
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
};

const variants = EVENT_TYPES.map((type) =>
  z.object({ ...envelope, type: z.literal(type), data: EVENT_DATA_SCHEMAS[type] }),
);

/** Runtime schema of a stored event (discriminated union on `type`). */
export const EventRecordSchema = z.discriminatedUnion(
  'type',
  variants as unknown as [(typeof variants)[number], ...(typeof variants)[number][]],
) as unknown as z.ZodType<EventRecord>;

/** Validate only the `data` of an event of `type`. */
export function parseEventData<T extends EventType>(type: T, data: unknown): EventData<T> {
  return EVENT_DATA_SCHEMAS[type].parse(data) as EventData<T>;
}

/** Events the leader conversation should hear about (fed through `LeaderNotifier`). */
export const LEADER_EVENT_TYPES: readonly EventType[] = [
  'task.status_changed',
  'task.escalated',
  'task.base_drift',
  'attention.opened',
  'runner.circuit_opened',
  'runner.cooldown',
  'recovery.completed',
];
