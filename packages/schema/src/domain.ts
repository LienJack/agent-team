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
  TierSchema,
} from './common.js';
import {
  AttentionIdSchema,
  DispatchIdSchema,
  MessageIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from './ids.js';
import { ReceiptSchema } from './receipts.js';
import { UsageSchema } from './runner.js';
import { RunKindSchema, RunOutcomeSchema, RunStateSchema, TaskStatusSchema } from './status.js';

// Persisted domain objects (spec §5). Optional columns are `T | null` (always present).

/** A project name doubles as the worktree directory name, so it is a slug. */
export const ProjectNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'lowercase letters, digits, ".", "_" or "-"');

/** One machine check run in the worktree during verification (spec §6 step 4). */
export const ProjectCheckSchema = z.object({
  name: z.string().min(1).max(64),
  /** Command line from the project owner's config, run in the worktree root. */
  cmd: z.string().min(1),
});
export type ProjectCheck = z.infer<typeof ProjectCheckSchema>;

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: ProjectNameSchema,
  /** Absolute path of the primary checkout. */
  repo_path: z.string().min(1),
  base_branch: z.string().min(1),
  checks: z.array(ProjectCheckSchema),
  /**
   * Whether sandboxed worker commands may reach the network (package installs, fetches). Off by
   * default; never includes this machine's own addresses (the service's ports). docs/adr/0014.
   */
  allow_network: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Why `path` is not an acceptable owned path, or null. Accepted: a repo-relative POSIX path or
 * glob, optionally with one leading `./` and one trailing `/`; `.` and `./` mean the whole repo.
 * Refused: empty, absolute (`/x`, `C:`), backslashes, `..`, empty segments (`a//b`) and `.`
 * segments inside the path (`a/./b`), so every accepted spelling has one meaning.
 */
export function ownedPathProblem(path: string): string | null {
  const p = path.trim();
  if (p === '') return 'must not be empty';
  if (p !== path) return 'must not start or end with whitespace';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be repo-relative (no absolute paths)';
  if (p.includes('\\')) return 'must use "/" (no backslashes)';
  if (p === '.' || p === './') return null;
  let rest = p.startsWith('./') ? p.slice(2) : p;
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  for (const seg of rest.split('/')) {
    if (seg === '') return 'must not contain empty segments ("a//b")';
    if (seg === '..') return 'must not contain ".."';
    if (seg === '.') return 'must not contain "." segments';
  }
  return null;
}

/**
 * Repo-relative POSIX path or glob a task may change. Literal entries match the path itself and
 * everything below it (`src/a` matches `src/a` and `src/a/b.ts`); globs support `*`, `**`, `?`;
 * `.` is the whole repository. See `ownedPathProblem` for the accepted spellings.
 */
export const OwnedPathSchema = z.string().superRefine((p, ctx) => {
  const problem = ownedPathProblem(p);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});

export const TaskSchema = z.object({
  id: TaskIdSchema,
  project_id: ProjectIdSchema,
  parent_id: TaskIdSchema.nullable(),
  title: z.string().min(1).max(200),
  tier: TierSchema,
  ticket_md: z.string(),
  owned_paths: z.array(OwnedPathSchema),
  /** Higher runs first; ties by created_at. */
  priority: z.number().int(),
  status: TaskStatusSchema,
  /** Role for impl/fix runs; changes on escalation or reassign. */
  impl_role: RoleNameSchema,
  /** Fix runs requested at the current impl_role. */
  fix_rounds: NonNegativeIntSchema,
  /** Retries requested by the leader since the last human retry (bounded; docs/adr/0014). */
  leader_retries: NonNegativeIntSchema,
  /** Consecutive failed attempts (runner errors / rejected dispatch); reset by a clean run. */
  attempts: NonNegativeIntSchema,
  blocked_reason: z.string().nullable(),
  /** Optimistic lock; incremented by every successful update. */
  version: PositiveIntSchema,
  // --- not listed in spec §5, needed by the engine (see docs/adr/0004) ---
  /** The only run allowed to change this task (fencing together with run.dispatch_id). */
  current_run_id: RunIdSchema.nullable(),
  /** Do not dispatch before this time (retry backoff). */
  retry_at: IsoDateTimeSchema.nullable(),
  /** Must-fix list / rejection details handed to the next fix run. */
  fix_notes: z.string().nullable(),
  /** Appended to the next prompt after a restart interrupted a run. */
  recovery_note: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const WorkspaceStateSchema = z.enum(['active', 'kept', 'removed']);
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

/** A task's git worktree. At most one non-removed workspace per task. */
export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  task_id: TaskIdSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  base_sha: ShaSchema,
  /** Last service-side commit. */
  head_sha: ShaSchema.nullable(),
  /**
   * Base tip a human accepted after a base drift ("continue on the old base"). The drift check
   * compares the base branch with this sha when set; `base_sha` stays the fork point because the
   * diff and ownership checks are relative to it.
   */
  accepted_base_sha: ShaSchema.nullable(),
  state: WorkspaceStateSchema,
  created_at: IsoDateTimeSchema,
  removed_at: IsoDateTimeSchema.nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  task_id: TaskIdSchema,
  workspace_id: WorkspaceIdSchema,
  /** Unique fencing token echoed by the receipt. */
  dispatch_id: DispatchIdSchema,
  kind: RunKindSchema,
  role: RoleNameSchema,
  model_alias: ModelAliasSchema,
  runner: RunnerNameSchema,
  model: z.string().min(1),
  state: RunStateSchema,
  outcome: RunOutcomeSchema.nullable(),
  reject_reason: z.string().nullable(),
  /** Runner error as `<kind>: <message>` (not in spec §5). */
  error: z.string().nullable(),
  session_ref: z.string().nullable(),
  receipt: ReceiptSchema.nullable(),
  usage: UsageSchema.nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  /**
   * `cost_usd` is an estimate from token usage × the `price` of models.json (the runner reported
   * no cost: codex, dsh), not a figure the provider reported.
   */
  cost_estimated: z.boolean(),
  log_dir: z.string().min(1),
  /** Process group leader of the worker (the runner's child; pgid == pid). */
  pid: PositiveIntSchema.nullable(),
  /**
   * Start time of `pid` as the OS reports it (`ps -o lstart`), so recovery never signals a
   * reused pid (docs/adr/0015).
   */
  pid_started_at: z.string().nullable(),
  /** Set just before the runner spawns the worker process; null = no process was ever spawned. */
  launched_at: IsoDateTimeSchema.nullable(),
  started_at: IsoDateTimeSchema,
  ended_at: IsoDateTimeSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const AttentionKindSchema = z.enum(['decision', 'approval', 'question']);
export const AttentionStatusSchema = z.enum(['open', 'answered', 'superseded']);
export const AnswerViaSchema = z.enum(['web', 'cli', 'mcp', 'grok', 'leader']);
export type AnswerVia = z.infer<typeof AnswerViaSchema>;

/** Something a human (or the leader) must decide; server state, not chat history. */
export const AttentionSchema = z.object({
  id: AttentionIdSchema,
  task_id: TaskIdSchema.nullable(),
  kind: AttentionKindSchema,
  question: z.string().min(1),
  options: z.array(z.string().min(1)),
  status: AttentionStatusSchema,
  answer: z.string().nullable(),
  answered_via: AnswerViaSchema.nullable(),
  created_at: IsoDateTimeSchema,
  answered_at: IsoDateTimeSchema.nullable(),
});
export type Attention = z.infer<typeof AttentionSchema>;

export const MessageChannelSchema = z.enum(['leader', 'grok']);
export type MessageChannel = z.infer<typeof MessageChannelSchema>;
export const MessageStatusSchema = z.enum(['new', 'delivered', 'acked']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const MessageSchema = z.object({
  id: MessageIdSchema,
  channel: MessageChannelSchema,
  direction: z.enum(['in', 'out']),
  source: MessageSourceSchema,
  body: z.string(),
  /** Client-chosen dedupe key, unique per channel (grok: the grokmsg id). */
  client_msg_id: z.string().min(1).max(200),
  /** Optional reference (task id, grokmsg thread, …). */
  ref: z.string().nullable(),
  status: MessageStatusSchema,
  /** Assigned by the repository on insert; increasing. */
  seq: PositiveIntSchema,
  created_at: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;
export type NewMessage = Omit<Message, 'seq'>;
