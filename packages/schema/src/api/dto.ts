import { z } from 'zod';
import {
  IsoDateTimeSchema,
  MessageSourceSchema,
  ModelAliasSchema,
  ModelRunnerSchema,
  NonNegativeIntSchema,
  RoleNameSchema,
  RunnerNameSchema,
  ShaSchema,
  TierSchema,
} from '../common.js';
import {
  AnswerViaSchema,
  AttentionKindSchema,
  AttentionSchema,
  AttentionStatusSchema,
  MAX_RESEARCH_REFS,
  MessageSchema,
  OwnedPathSchema,
  ProjectCheckSchema,
  ProjectNameSchema,
  ProjectSchema,
  RunSchema,
  TaskSchema,
  WorkspaceSchema,
} from '../domain.js';
import { MessageIdSchema, ProjectIdSchema, RunIdSchema, TaskIdSchema } from '../ids.js';
import { RunnerStatusSchema } from '../records.js';
import { BoardSummarySchema, DeliverySchema } from '../delivery.js';
import { ResearchReceiptSchema } from '../research-receipt.js';
import { RunnerCapabilitiesSchema, UsageSchema } from '../runner.js';
import { RunKindSchema, RunStateSchema, TaskStatusSchema } from '../status.js';
import { TaskWaitingSchema } from '../waiting.js';

// Request/response bodies for the routes under /api (spec §11). Wire shapes are snake_case.

/**
 * `client_msg_id` prefixes the server uses for messages it stores itself (leader replies, event
 * digests, generated ids); a client id with one of them could shadow or pre-empt a server
 * message, so the API refuses it.
 */
export const RESERVED_CLIENT_MSG_ID_PREFIXES = ['reply:', 'events:', 'm_'] as const;
export function isReservedClientMsgId(id: string): boolean {
  return RESERVED_CLIENT_MSG_ID_PREFIXES.some((p) => id.startsWith(p));
}

const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

// -------------------------------------------------------------------- state

/** Why the leader cannot take turns right now (`available: false`). */
export const LeaderUnavailableReasonSchema = z.enum([
  /** No leader conversation in this process (`service.json` leader.enabled = false, tests). */
  'disabled',
  /** The claude CLI is missing or lacks a required flag. */
  'not_installed',
  /** Not logged in: log in, then `team leader reset`. */
  'auth',
  /** Subscription limit; retried at `until`. */
  'rate_limit',
]);
export type LeaderUnavailableReason = z.infer<typeof LeaderUnavailableReasonSchema>;

/**
 * Leader status (spec §9). `state` keeps the phase 2 values (`offline` = no answers right now:
 * messages are stored and answered later); the optional fields are filled by the real leader.
 */
export const LeaderStatusSchema = z.object({
  state: z.enum(['idle', 'busy', 'offline']),
  last_activity_at: IsoDateTimeSchema.nullable(),
  /** false while turns cannot run; `reason`/`hint`/`until` say why and until when. */
  available: z.boolean().optional(),
  reason: LeaderUnavailableReasonSchema.nullable().optional(),
  hint: z.string().nullable().optional(),
  until: IsoDateTimeSchema.nullable().optional(),
  /** Inputs waiting for a turn (human messages, plus 1 for pending engine events). */
  queued: NonNegativeIntSchema.optional(),
  /** Context size after the last turn (tokens); compaction runs above the threshold. */
  context_tokens: NonNegativeIntSchema.nullable().optional(),
  /** Latest subscription quota seen in the leader's own stream (`rate_limit_event`). */
  quota: z
    .object({
      utilization: z.number().min(0).max(1).nullable(),
      resets_at: IsoDateTimeSchema.nullable(),
      exhausted: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type LeaderStatus = z.infer<typeof LeaderStatusSchema>;

/** What a board card shows of a task's latest run (the current one, else the newest). */
export const TaskRunSummarySchema = z.object({
  id: RunIdSchema,
  kind: RunKindSchema,
  role: RoleNameSchema,
  model_alias: ModelAliasSchema,
  runner: RunnerNameSchema,
  state: RunStateSchema,
  cost_usd: z.number().nonnegative().nullable(),
  /** `cost_usd` is estimated from usage × models.json prices (runner reported none). */
  cost_estimated: z.boolean(),
  usage: UsageSchema.nullable(),
  started_at: IsoDateTimeSchema,
  ended_at: IsoDateTimeSchema.nullable(),
});
export type TaskRunSummary = z.infer<typeof TaskRunSummarySchema>;

/**
 * A task as the board snapshot carries it: the task plus what its card shows, so cards need no
 * request of their own — the latest run, the workspace's last service-side commit and the sums
 * over all runs (a live run's own time is added by the viewer: `now - latest_run.started_at`).
 */
export const BoardTaskSchema = TaskSchema.extend({
  latest_run: TaskRunSummarySchema.nullable(),
  /** Why the waiting task is not dispatched yet (null when it is not waiting, or not known yet). */
  waiting: TaskWaitingSchema.extend({ since: IsoDateTimeSchema }).nullable(),
  /** `head_sha` of the task's current workspace (null before the first commit). */
  head_sha: ShaSchema.nullable(),
  run_totals: z.object({
    runs: NonNegativeIntSchema,
    /** Sum of known costs (reported or estimated); null when no run has one. */
    cost_usd: z.number().nonnegative().nullable(),
    /** At least one part of `cost_usd` is an estimate. */
    cost_estimated: z.boolean(),
    /** Summed token counts of all runs. */
    usage: UsageSchema,
    /** Summed duration of the runs that ended (ms). */
    finished_ms: NonNegativeIntSchema,
  }),
});
export type BoardTask = z.infer<typeof BoardTaskSchema>;

/** GET /state — board snapshot; `last_seq` is the cursor to continue with GET /events. */
export const StateResponseSchema = z.object({
  last_seq: NonNegativeIntSchema,
  generated_at: IsoDateTimeSchema,
  projects: z.array(ProjectSchema),
  tasks: z.array(BoardTaskSchema),
  active_runs: z.array(RunSchema),
  open_attention: z.array(AttentionSchema),
  runners: z.array(RunnerStatusSchema),
  leader: LeaderStatusSchema,
  /** Counts per board column that sum to `total`, and the generated line (`team status`). */
  summary: BoardSummarySchema,
  /** Project memory is on (spec §18): the board offers each project's memory list. */
  memory_enabled: z.boolean(),
});
export type StateResponse = z.infer<typeof StateResponseSchema>;

/** GET /events?after=<seq> (SSE). Each data frame is an `EventRecord` or a control frame. */
export const EventsQuerySchema = z.object({
  after: queryInt(0, Number.MAX_SAFE_INTEGER).optional(),
});
export const ServerConnectedFrameSchema = z.object({
  type: z.literal('server.connected'),
  last_seq: NonNegativeIntSchema,
  ts: IsoDateTimeSchema,
});
export type ServerConnectedFrame = z.infer<typeof ServerConnectedFrameSchema>;

// ----------------------------------------------------------------- projects

/** POST /projects (local listener only). */
export const ProjectCreateRequestSchema = z.object({
  name: ProjectNameSchema,
  repo_path: z.string().startsWith('/', 'must be an absolute path'),
  base_branch: z.string().min(1).default('main'),
  checks: z.array(ProjectCheckSchema).default([]),
  /** Let sandboxed worker commands use the network (never this machine's own ports). */
  allow_network: z.boolean().default(false),
});
export type ProjectCreateRequest = z.input<typeof ProjectCreateRequestSchema>;
export const ProjectResponseSchema = z.object({ project: ProjectSchema });
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectSchema) });

// -------------------------------------------------------------------- tasks

/** POST /tasks. `impl_role` defaults to `impl_<tier>`; `queue: true` skips the draft column. */
export const TaskCreateRequestSchema = z.object({
  project_id: ProjectIdSchema,
  parent_id: TaskIdSchema.optional(),
  title: z.string().min(1).max(200),
  tier: TierSchema,
  ticket_md: z.string().min(1),
  owned_paths: z.array(OwnedPathSchema).min(1),
  priority: z.number().int().default(0),
  impl_role: RoleNameSchema.optional(),
  queue: z.boolean().default(false),
  /**
   * Done research tasks of the same project to cite (spec §17): their receipts go into this
   * task's impl/fix/review prompts as reference data. 409 while `research.mode` is `off`.
   */
  research_refs: z.array(TaskIdSchema).max(MAX_RESEARCH_REFS).default([]),
});
export type TaskCreateRequest = z.input<typeof TaskCreateRequestSchema>;

/**
 * POST /research (`team research add`, spec §17): a research task — the question is the whole
 * ticket; no tier, paths or checks. 409 while `research.mode` is `off`.
 */
export const ResearchCreateRequestSchema = z.object({
  project_id: ProjectIdSchema,
  parent_id: TaskIdSchema.optional(),
  title: z.string().min(1).max(200),
  question: z.string().trim().min(1).max(8000),
  priority: z.number().int().default(0),
  queue: z.boolean().default(false),
});
export type ResearchCreateRequest = z.input<typeof ResearchCreateRequestSchema>;

/**
 * GET /research/:id (`team research show`): the research task and the receipt of its last
 * accepted run (null until one finished). The candidate links were NOT checked by the service
 * (only that they are https without credentials).
 */
export const ResearchDetailResponseSchema = z.object({
  task: TaskSchema,
  receipt: ResearchReceiptSchema.nullable(),
  run_id: RunIdSchema.nullable(),
});
export type ResearchDetailResponse = z.infer<typeof ResearchDetailResponseSchema>;

/** GET /tasks?project_id=&status=queued,running */
export const TaskListQuerySchema = z.object({
  project_id: ProjectIdSchema.optional(),
  status: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(TaskStatusSchema))
    .optional(),
});
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskSchema) });
export const TaskResponseSchema = z.object({ task: TaskSchema });
/**
 * Every task command (create, research create, queue, cancel, retry, approve, reject,
 * reassign): the task as it is now, what that means for its dispatch (`delivery`, derived from
 * the stored state after one scheduling pass) and the generated one-line `report` the leader
 * relays (docs/adr/0022). A replayed request (same Idempotency-Key) gets them recomputed.
 */
export const TaskCommandResponseSchema = TaskResponseSchema.extend({
  delivery: DeliverySchema,
  report: z.string(),
});
export type TaskCommandResponse = z.infer<typeof TaskCommandResponseSchema>;

/** GET /tasks/:id — task with its runs (receipts included), workspace and attention items. */
export const TaskDetailResponseSchema = z.object({
  task: TaskSchema,
  runs: z.array(RunSchema),
  workspace: WorkspaceSchema.nullable(),
  attention: z.array(AttentionSchema),
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;

/** POST /tasks/:id/{queue,cancel,retry,approve} */
export const TaskActionRequestSchema = z.object({ reason: z.string().max(2000).optional() });
/** POST /tasks/:id/reject — the note becomes the fix run's must-fix list. */
export const TaskRejectRequestSchema = z.object({ note: z.string().min(1).max(4000) });
/** POST /tasks/:id/reassign */
export const TaskReassignRequestSchema = z.object({ role: RoleNameSchema });
export const TaskActionSchema = z.enum(['queue', 'cancel', 'retry', 'approve', 'reject']);
export type TaskAction = z.infer<typeof TaskActionSchema>;

// -------------------------------------------------------------------- roles

/** One role of `config/models.json` (GET /roles; reassign pickers and `team task reassign`). */
export const RoleInfoSchema = z.object({
  name: RoleNameSchema,
  description: z.string().nullable(),
  /** Model alias the role uses first (`roles.<name>.use`). */
  model_alias: ModelAliasSchema,
  /** Runner of that alias (`models.<alias>.runner`). */
  runner: ModelRunnerSchema,
  slots: NonNegativeIntSchema,
  enabled: z.boolean(),
  /** Aliases tried in order while the first one is unavailable. */
  fallback: z.array(ModelAliasSchema),
});
export type RoleInfo = z.infer<typeof RoleInfoSchema>;
export const RolesResponseSchema = z.object({ roles: z.array(RoleInfoSchema) });

// --------------------------------------------------------------------- runs

/** GET /runs/:id/log?tail= — for humans only (never part of the leader's command set). */
export const RunLogQuerySchema = z.object({ tail: queryInt(1, 5000).default(200) });
export const RunLogResponseSchema = z.object({
  run_id: z.string(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

// ------------------------------------------------------------------- leader

/**
 * POST /leader/messages. `wait: false` returns as soon as the message is stored and queued (the
 * reply arrives as a `leader.reply` event and in GET /leader/messages); `wait: true` (default)
 * waits for the reply up to the server's cap (`leader.reply_wait_ms`, below the 300 s header
 * timeout of Node's fetch) and then answers `pending: true` instead of an error.
 */
export const LeaderMessageRequestSchema = z.object({
  text: z.string().min(1).max(20000),
  /**
   * Ignored (accepted for old clients): the server derives the source from the listener and the
   * credential — LAN session → `web`, operator token → `cli`.
   */
  source: MessageSourceSchema.optional(),
  client_msg_id: z
    .string()
    .min(1)
    .max(200)
    .refine((id) => !isReservedClientMsgId(id), {
      message: `must not start with a server prefix (${RESERVED_CLIENT_MSG_ID_PREFIXES.join(', ')})`,
    }),
  wait: z.boolean().default(true),
});
export type LeaderMessageRequest = z.input<typeof LeaderMessageRequestSchema>;
/** `pending: true` = stored and queued, no reply yet (`reply` and `reply_message_id` null). */
export const LeaderMessageResponseSchema = z.object({
  message_id: MessageIdSchema,
  pending: z.boolean(),
  reply: z.string().nullable(),
  reply_message_id: z.string().nullable(),
  /** The leader right now (e.g. `available: false` while a queued message waits for a reset). */
  leader: LeaderStatusSchema,
});
export type LeaderMessageResponse = z.infer<typeof LeaderMessageResponseSchema>;
/**
 * GET /leader/messages/:id — one input and its reply, for callers waiting on a pending message
 * (`team ask`, MCP `ask_leader`). `reply: null` with the input no longer `new` = the leader
 * could not answer it (send again).
 */
export const LeaderMessageDetailResponseSchema = z.object({
  message: MessageSchema,
  reply: MessageSchema.nullable(),
  leader: LeaderStatusSchema,
});
export type LeaderMessageDetailResponse = z.infer<typeof LeaderMessageDetailResponseSchema>;
/** GET /leader/messages?after=&limit= */
export const LeaderMessagesQuerySchema = z.object({
  after: queryInt(0, Number.MAX_SAFE_INTEGER).optional(),
  limit: queryInt(1, 500).default(100),
});
export const LeaderMessagesResponseSchema = z.object({ messages: z.array(MessageSchema) });

/**
 * POST /leader/reset (`team leader reset`, local listener only): start a new conversation
 * (new session id, the resume brief on its first turn), e.g. under another login.
 */
export const LeaderResetResponseSchema = z.object({
  session_id: z.string(),
  leader: LeaderStatusSchema,
});
export type LeaderResetResponse = z.infer<typeof LeaderResetResponseSchema>;

// ---------------------------------------------------------------- attention

/** POST /attention (`team attention open`). */
export const AttentionCreateRequestSchema = z.object({
  task_id: TaskIdSchema.optional(),
  kind: AttentionKindSchema.default('decision'),
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(200)).max(10).default([]),
});
export type AttentionCreateRequest = z.input<typeof AttentionCreateRequestSchema>;
export const AttentionListQuerySchema = z.object({ status: AttentionStatusSchema.optional() });
export const AttentionListResponseSchema = z.object({ attention: z.array(AttentionSchema) });
/**
 * POST /attention/:id/answer (humans only). `via` is ignored (accepted for old clients) and
 * derived like a message source: LAN → `web`, operator token → `cli`.
 */
export const AttentionAnswerRequestSchema = z.object({
  answer: z.string().min(1).max(4000),
  via: AnswerViaSchema.optional(),
});
export type AttentionAnswerRequest = z.infer<typeof AttentionAnswerRequestSchema>;
export const AttentionResponseSchema = z.object({ attention: AttentionSchema });

// ----------------------------------------------------- resume, quota, doctor

/** GET /resume — model-free status summary for a new leader conversation. */
export const ResumeResponseSchema = z.object({
  summary_md: z.string(),
  generated_at: IsoDateTimeSchema,
});
/** GET /quota */
export const QuotaResponseSchema = z.object({ runners: z.array(RunnerStatusSchema) });
/** GET /doctor */
export const DoctorResponseSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  runners: z.array(RunnerCapabilitiesSchema),
});
export type DoctorResponse = z.infer<typeof DoctorResponseSchema>;

// --------------------------------------------------------------------- auth

/** POST /auth/login (LAN listener) → HttpOnly, SameSite=Strict session cookie. */
export const LoginRequestSchema = z.object({ password: z.string().min(1).max(1000) });
export const LoginResponseSchema = z.object({ ok: z.literal(true) });
