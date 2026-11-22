import { z } from 'zod';
import { NonNegativeIntSchema } from './common.js';
import { RunIdSchema } from './ids.js';
import { BOARD_COLUMNS, type TaskKind, type TaskStatus } from './status.js';
import { TaskWaitingSchema, type TaskWaitReason, type TaskWaiting } from './waiting.js';

// What happened to a task's dispatch, said by code instead of by the leader (docs/adr/0022 §1).
// Every task command answers with `delivery` (derived from persisted state at response time) and
// a one-line `report` in Traditional Chinese that states exactly that; the leader relays the
// report instead of describing the task itself, so it cannot call a queued task "running".

/**
 * - `running`: a worker run of the task is live (impl/fix/review/research), or the service is
 *   verifying the result of its run (`verifying`);
 * - `queued`: waiting for a worker (`queued`, or `review` before its review run starts), with
 *   the scheduler's current reason (`task.waiting`) when one is known;
 * - `draft`: created but not queued — nothing will run until it is queued;
 * - `done`: finished;
 * - `not_accepted`: nothing will run as things stand: the request was refused, or the task is
 *   blocked, failed or cancelled (`reason` says which and why).
 */
export const DELIVERY_STATES = ['running', 'queued', 'draft', 'done', 'not_accepted'] as const;
export const DeliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const DeliverySchema = z.object({
  state: DeliveryStateSchema,
  /** `queued`: why it waits (the `task.waiting` reasons); null when not known (yet). */
  waiting: TaskWaitingSchema.nullable(),
  /** `running`: the run that is live (or being verified). */
  run_id: RunIdSchema.nullable(),
  /** `not_accepted`: why nothing runs. */
  reason: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

/** The persisted facts a delivery is derived from. */
export interface DeliveryInput {
  task: { status: TaskStatus; blocked_reason: string | null; current_run_id: string | null };
  /** The task's current run when it is live (`starting`/`running`), else null. */
  liveRunId: string | null;
  /** The scheduler's current reason for a waiting task (engine `waitingOf`), else null. */
  waiting: TaskWaiting | null;
}

const delivery = (state: DeliveryState, rest: Partial<Omit<Delivery, 'state'>> = {}) => ({
  state,
  waiting: rest.waiting ?? null,
  run_id: rest.run_id ?? null,
  reason: rest.reason ?? null,
});

const live = (i: DeliveryInput): Delivery =>
  i.liveRunId !== null
    ? delivery('running', { run_id: i.liveRunId })
    : delivery('queued', { waiting: i.waiting });

/** Exhaustive: a new task status fails the type check here. */
const BY_STATUS: Record<TaskStatus, (i: DeliveryInput) => Delivery> = {
  draft: () => delivery('draft'),
  queued: (i) => delivery('queued', { waiting: i.waiting }),
  running: live,
  verifying: (i) => delivery('running', { run_id: i.task.current_run_id }),
  review: live,
  done: () => delivery('done'),
  blocked: (i) => delivery('not_accepted', { reason: i.task.blocked_reason ?? '任務阻塞' }),
  failed: (i) =>
    delivery('not_accepted', { reason: i.task.blocked_reason ?? '重試次數已用完（failed）' }),
  cancelled: () => delivery('not_accepted', { reason: '任務已取消' }),
};

export function deliveryOf(input: DeliveryInput): Delivery {
  return BY_STATUS[input.task.status](input);
}

/** A request the service refused (error envelope) or never answered (connection). */
export function refusedDelivery(reason: string): Delivery {
  return delivery('not_accepted', { reason });
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const WAIT_TEXT: Record<TaskWaitReason, (w: TaskWaiting) => string> = {
  path_overlap: (w) =>
    w.blocking_task_id
      ? `owned_paths 與進行中的任務 ${w.blocking_task_id} 重疊`
      : 'owned_paths 與正在派工的任務重疊',
  no_slot: () => '執行槽位已滿',
  runner_cooldown: (w) =>
    `可用的 runner 都在冷卻或停用中${w.retry_at ? `，最早 ${w.retry_at} 再試` : ''}`,
  backoff: (w) => `上次失敗後退避中${w.retry_at ? `，${w.retry_at} 重試` : ''}`,
  worker_alive: () => '前一個 worker 可能還在執行',
  base_drift: () => '基底分支已變動，等人回答待決事項',
};

/** Why a queued task waits, in words (`等待排程` when the scheduler has not said yet). */
export function waitingText(waiting: TaskWaiting | null): string {
  return waiting ? WAIT_TEXT[waiting.reason](waiting) : '等待排程';
}

export interface ReportedTask {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
}

/** `任務 t_…「標題」` / `調研任務 …` */
function subject(task: ReportedTask): string {
  return `${task.kind === 'research' ? '調研任務' : '任務'} ${task.id}「${oneLine(task.title, 60)}」`;
}

/** The one-line report of one task's delivery; it never says "running" unless `d` does. */
export function deliveryReport(task: ReportedTask, d: Delivery): string {
  const who = subject(task);
  switch (d.state) {
    case 'draft':
      return `${who}是草稿：尚未排入佇列，不會執行（要派工請用 team task queue ${task.id}）。`;
    case 'queued':
      return task.status === 'review'
        ? `${who}已提交，等待審查 run 開始，尚未執行（${waitingText(d.waiting)}）。`
        : `${who}已排入佇列，尚未開始執行（${waitingText(d.waiting)}）。`;
    case 'running':
      if (task.status === 'verifying') {
        return `${who}的 worker 已交回執，服務端正在核對（run ${d.run_id ?? '-'}）。`;
      }
      return task.status === 'review'
        ? `${who}正在審查（run ${d.run_id ?? '-'}）。`
        : `${who}正在執行（run ${d.run_id ?? '-'}）。`;
    case 'done':
      return `${who}已完成。`;
    case 'not_accepted': {
      const why = oneLine(d.reason ?? '', 160);
      if (task.status === 'cancelled') return `${who}已取消，不會執行。`;
      if (task.status === 'failed') return `${who}已失敗，不會再執行：${why}。`;
      return `${who}已阻塞，不會執行：${why}。`;
    }
  }
}

/** Report of a request the service refused; nothing was created or changed. */
export function refusedReport(code: string, message: string, reachedServer: boolean): string {
  const why = oneLine(message, 200);
  return reachedServer
    ? `請求未被受理（${code}）：${why}。沒有建立或改變任何任務。`
    : `無法連線到服務（${why}），無法確認請求是否已受理；先用 team task list 確認。`;
}

const STATE_LABEL: Record<DeliveryState, string> = {
  running: '執行中',
  queued: '排隊中（尚未執行）',
  draft: '草稿',
  done: '已完成',
  not_accepted: '不會執行',
};

/**
 * Report of several results (a batch): counts per delivery state that sum to the total, then
 * one clause per task that will not run. No batch command exists today; this keeps the wording
 * of a future one identical.
 */
export function deliveriesReport(
  results: ReadonlyArray<{ task: ReportedTask; delivery: Delivery }>,
): string {
  if (results.length === 1) return deliveryReport(results[0]!.task, results[0]!.delivery);
  const counts = DELIVERY_STATES.map(
    (s) => [s, results.filter((r) => r.delivery.state === s).length] as const,
  ).filter(([, n]) => n > 0);
  const parts = counts.map(([s, n]) => `${STATE_LABEL[s]} ${n}`);
  return `共 ${results.length} 個任務：${parts.join('、')}。`;
}

// ------------------------------------------------------------------ board summary

export const BoardSummarySchema = z.object({
  /** Tasks on the board (every status but `cancelled`); the five columns sum to it. */
  total: NonNegativeIntSchema,
  columns: z.object({
    pending: NonNegativeIntSchema,
    in_progress: NonNegativeIntSchema,
    review: NonNegativeIntSchema,
    blocked: NonNegativeIntSchema,
    done: NonNegativeIntSchema,
  }),
  /** `pending` split: drafts (never run until queued) and queued tasks. */
  drafts: NonNegativeIntSchema,
  queued: NonNegativeIntSchema,
  /** Not on the board, not in `total`. */
  cancelled: NonNegativeIntSchema,
  /** One line in Traditional Chinese (`team status`); the leader relays it. */
  report: z.string(),
});
export type BoardSummary = z.infer<typeof BoardSummarySchema>;

/** Counts per board column (spec §5) that sum to `total`, and the line saying them. */
export function boardSummary(tasks: ReadonlyArray<{ status: TaskStatus }>): BoardSummary {
  const count = (statuses: readonly TaskStatus[]) =>
    tasks.filter((t) => statuses.includes(t.status)).length;
  const columns = Object.fromEntries(
    BOARD_COLUMNS.map((c) => [c.id, count(c.statuses)]),
  ) as BoardSummary['columns'];
  const total = BOARD_COLUMNS.reduce((sum, c) => sum + columns[c.id], 0);
  const drafts = count(['draft']);
  const queued = count(['queued']);
  const cancelled = count(['cancelled']);
  const label = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.id, c.label]));
  const parts = BOARD_COLUMNS.map((c) =>
    c.id === 'pending'
      ? `${label[c.id]} ${columns.pending}（草稿 ${drafts}、排隊 ${queued}，都尚未執行）`
      : `${label[c.id]} ${columns[c.id]}`,
  );
  const extra = cancelled > 0 ? `；另有 ${cancelled} 個已取消（不在看板上）` : '';
  return {
    total,
    columns,
    drafts,
    queued,
    cancelled,
    report: `看板共 ${total} 個任務：${parts.join('、')}${extra}。`,
  };
}
