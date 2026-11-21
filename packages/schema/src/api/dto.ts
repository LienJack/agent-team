import { z } from 'zod';
import {
  IsoDateTimeSchema,
  MessageSourceSchema,
  NonNegativeIntSchema,
  RoleNameSchema,
  TierSchema,
} from '../common.js';
import {
  AnswerViaSchema,
  AttentionKindSchema,
  AttentionSchema,
  AttentionStatusSchema,
  MessageSchema,
  OwnedPathSchema,
  ProjectCheckSchema,
  ProjectNameSchema,
  ProjectSchema,
  RunSchema,
  TaskSchema,
  WorkspaceSchema,
} from '../domain.js';
import { ProjectIdSchema, TaskIdSchema } from '../ids.js';
import { RunnerStatusSchema } from '../records.js';
import { RunnerCapabilitiesSchema } from '../runner.js';
import { TaskStatusSchema } from '../status.js';

// Request/response bodies for the routes under /api (spec §11). Wire shapes are snake_case.

const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

// -------------------------------------------------------------------- state

/** Why the leader cannot take turns right now (`available: false`). */
export const LeaderUnavailableReasonSchema = z.enum([
  /** No leader conversation in this process (fake runners, tests). */
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

/** GET /state — board snapshot; `last_seq` is the cursor to continue with GET /events. */
export const StateResponseSchema = z.object({
  last_seq: NonNegativeIntSchema,
  generated_at: IsoDateTimeSchema,
  projects: z.array(ProjectSchema),
  tasks: z.array(TaskSchema),
  active_runs: z.array(RunSchema),
  open_attention: z.array(AttentionSchema),
  runners: z.array(RunnerStatusSchema),
  leader: LeaderStatusSchema,
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
});
export type TaskCreateRequest = z.input<typeof TaskCreateRequestSchema>;

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

// --------------------------------------------------------------------- runs

/** GET /runs/:id/log?tail= — for humans only (never part of the leader's command set). */
export const RunLogQuerySchema = z.object({ tail: queryInt(1, 5000).default(200) });
export const RunLogResponseSchema = z.object({
  run_id: z.string(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

// ------------------------------------------------------------------- leader

/** POST /leader/messages */
export const LeaderMessageRequestSchema = z.object({
  text: z.string().min(1).max(20000),
  source: MessageSourceSchema,
  client_msg_id: z.string().min(1).max(200),
});
export type LeaderMessageRequest = z.infer<typeof LeaderMessageRequestSchema>;
export const LeaderMessageResponseSchema = z.object({
  reply: z.string(),
  message_id: z.string(),
  reply_message_id: z.string().nullable(),
});
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
/** POST /attention/:id/answer */
export const AttentionAnswerRequestSchema = z.object({
  answer: z.string().min(1).max(4000),
  via: AnswerViaSchema,
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
