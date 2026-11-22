import {
  clipText,
  isResearchReceipt,
  RESEARCH_LIMITS,
  RESEARCH_ROLE,
  ResearchCreateRequestSchema,
  ResearchReceiptSchema,
  redactSecrets,
  type ResearchCreateRequest,
  type ResearchReceipt,
  type Run,
  type Task,
} from '@agent-team/schema';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { Repositories } from '../ports/repositories.js';
import { WORKER_REPORT_BLOCK } from './answers.js';
import { openAttention } from './attention.js';
import type { Actor } from './commands.js';
import type { EngineContext, Tx } from './context.js';
import { blockTask, completeTask, retryLater } from './outcomes.js';
import type { ResearchRef } from './prompt-research.js';
import { finishRun } from './records.js';

// The research stage (spec §17; docs/adr/0021): creating research tasks, citing them from impl
// tasks, and applying a research receipt. Dispatch and prompts live in dispatch.ts and
// prompt-research.ts.

/** 409 while `service.json` research.mode is `off` (every research entrance). */
export function requireResearchEnabled(ctx: EngineContext, what: string): void {
  if (ctx.config.research.mode === 'off') {
    throw new ConflictError(
      `${what}: the research stage is off (service.json research.mode = "off")`,
      'set research.mode to "on_request" or "auto" and restart the service',
    );
  }
}

/**
 * The receipt of the task's last accepted research run that reported `done` (with `any`: the
 * last accepted one, `blocked`/`failed` included), if any.
 */
export function researchReceiptOf(
  r: Pick<Repositories, 'runs'>,
  taskId: string,
  opts: { any?: boolean } = {},
): { run: Run; receipt: ResearchReceipt } | undefined {
  const runs = r.runs.list({ task_id: taskId });
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.kind !== 'research' || run.outcome !== 'ok') continue;
    if (isResearchReceipt(run.receipt) && (opts.any === true || run.receipt.status === 'done')) {
      return { run, receipt: run.receipt };
    }
  }
  return undefined;
}

/**
 * Check `research_refs` of a new task (spec §17): at most 3, distinct, every one a done research
 * task of the same project. Returns the refs to store (deduplicated, in the given order).
 */
export function checkResearchRefs(
  r: Pick<Repositories, 'tasks' | 'runs'>,
  projectId: string,
  refs: readonly string[],
): string[] {
  const unique = [...new Set(refs)];
  for (const id of unique) {
    const ref = r.tasks.get(id);
    if (!ref) throw new NotFoundError('task', id);
    if (ref.kind !== 'research') {
      throw new ValidationError(`research_refs: ${id} is not a research task`);
    }
    if (ref.project_id !== projectId) {
      throw new ValidationError(`research_refs: ${id} belongs to another project`);
    }
    if (ref.status !== 'done' || !researchReceiptOf(r, id)) {
      throw new ValidationError(
        `research_refs: ${id} is ${ref.status}, not done`,
        'cite a research task once it has finished',
      );
    }
  }
  return unique;
}

/** What a prompt of `task` gets from its cited research tasks (missing ones are skipped). */
export function researchRefsFor(tx: Tx, task: Task): ResearchRef[] {
  return task.research_refs.flatMap((id) => {
    const ref = tx.r.tasks.get(id);
    const found = ref ? researchReceiptOf(tx.r, id) : undefined;
    return ref && found ? [{ task_id: id, title: ref.title, receipt: found.receipt }] : [];
  });
}

/**
 * `team research add` (spec §17): a research task in `draft` (or `queued`). The question is its
 * ticket; it has no paths, its tier is unused and its role is `oss_researcher`.
 */
export function createResearch(
  ctx: EngineContext,
  input: ResearchCreateRequest,
  actor: Actor,
): Task {
  requireResearchEnabled(ctx, 'creating a research task');
  const parsed = ResearchCreateRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(
      issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'invalid request',
    );
  }
  const req = parsed.data;
  if (!ctx.config.models.roles[RESEARCH_ROLE]) {
    throw new ValidationError(
      `unknown role ${RESEARCH_ROLE}`,
      'add it to config/models.json roles',
    );
  }
  const task = ctx.transact((tx) => {
    if (!tx.r.projects.get(req.project_id)) throw new NotFoundError('project', req.project_id);
    if (req.parent_id !== undefined && !tx.r.tasks.get(req.parent_id)) {
      throw new NotFoundError('task', req.parent_id);
    }
    const created: Task = {
      id: ctx.newId('task'),
      project_id: req.project_id,
      parent_id: req.parent_id ?? null,
      kind: 'research',
      title: req.title,
      tier: 'C',
      ticket_md: req.question,
      owned_paths: [],
      research_refs: [],
      priority: req.priority,
      status: req.queue ? 'queued' : 'draft',
      impl_role: RESEARCH_ROLE,
      fix_rounds: 0,
      leader_retries: 0,
      attempts: 0,
      blocked_reason: null,
      version: 1,
      current_run_id: null,
      retry_at: null,
      fix_notes: null,
      recovery_note: null,
      created_at: tx.now,
      updated_at: tx.now,
    };
    tx.r.tasks.insert(created);
    tx.emit(
      'task.created',
      { title: created.title, status: created.status },
      { task_id: created.id },
    );
    return created;
  });
  if (task.status === 'queued' && actor.kind === 'human') ctx.humanPriority.add(task.id);
  return task;
}

/**
 * The receipt as stored and shown (M8, spec §17): every string redacted like a log line, then
 * clipped to its cap again (redaction can lengthen a value) and validated again — a URL the
 * redactor changed into something that is no longer an https URL without credentials makes the
 * receipt unusable. Returns the problem as a string in that case.
 */
export function sanitizeResearchReceipt(receipt: ResearchReceipt): ResearchReceipt | string {
  const L = RESEARCH_LIMITS;
  const clean = (text: string, max: number) => clipText(redactSecrets(text), max);
  const next: ResearchReceipt = {
    ...receipt,
    summary: clean(receipt.summary, L.summary),
    needs_leader: clean(receipt.needs_leader, L.needs_leader),
    candidates: receipt.candidates.map((c) => ({
      ...c,
      name: clean(c.name, L.name),
      url: redactSecrets(c.url),
      license: clean(c.license, L.license),
      borrow: clean(c.borrow, L.borrow),
      caveats: clean(c.caveats, L.caveats),
    })),
  };
  const checked = ResearchReceiptSchema.safeParse(next);
  if (checked.success) return checked.data;
  const issue = checked.error.issues[0];
  return `${issue?.path.join('.') ?? 'receipt'}: ${issue?.message ?? 'invalid'} (after redaction)`;
}

type RunFields = Pick<Run, 'usage' | 'cost_usd' | 'cost_estimated' | 'session_ref'>;

/**
 * A research run delivered a valid receipt for the current dispatch (spec §17): `done` → the
 * task is done and `research.completed` carries the result to the leader and the board;
 * `blocked`/`failed` → the task is blocked like an impl worker's report (needs_leader opens an
 * attention item; answering it queues the task again).
 */
export function applyResearchReceipt(
  ctx: EngineContext,
  tx: Tx,
  run: Run,
  task: Task,
  parsed: ResearchReceipt,
  fields: RunFields,
): void {
  const receipt = sanitizeResearchReceipt(parsed);
  if (typeof receipt === 'string') {
    const reason = `invalid_receipt: ${receipt}`;
    finishRun(tx, run, {
      ...fields,
      state: 'succeeded',
      outcome: 'rejected',
      reject_reason: reason,
    });
    retryLater(ctx, tx, task, 'research', { countAttempt: true, reason });
    return;
  }
  finishRun(tx, run, { ...fields, state: 'succeeded', outcome: 'ok', receipt });
  const note = receipt.needs_leader.trim();
  if (receipt.status !== 'done') {
    // only a run that stopped asks a question; a finished run's remark rides on the event below
    // (an attention item on a done task would be superseded at once)
    if (note !== '') {
      openAttention(ctx, tx, {
        task_id: task.id,
        kind: 'question',
        topic: 'worker_question',
        question: note,
        options: [],
      });
    }
    blockTask(ctx, tx, task, `${WORKER_REPORT_BLOCK}${receipt.status}：${receipt.summary}`);
    return;
  }
  tx.emit(
    'research.completed',
    {
      recommendation: receipt.recommendation,
      summary: receipt.summary,
      candidates: receipt.candidates.map(({ name, url, license, fit }) => ({
        name,
        url,
        license,
        fit,
      })),
      ...(note === '' ? {} : { note }),
    },
    { task_id: task.id, run_id: run.id },
  );
  completeTask(ctx, tx, task, `research done (run ${run.id})`);
}
