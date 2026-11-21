import type { Clock, Store } from '@agent-team/core';
import type { Attention, ImplReceipt, ReviewReceipt, Run, Task } from '@agent-team/schema';
import { LEADER_RECEIPTS_CURSOR_KEY } from './types.js';

// GET /api/resume (spec §9): a status summary built without any model, for a new leader
// conversation or after a login change. Everything comes from the database.

const IN_PROGRESS = ['running', 'verifying', 'review'] as const;
const MAX_RECEIPTS = 20;

function clip(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function isReview(receipt: ImplReceipt | ReviewReceipt): receipt is ReviewReceipt {
  return 'verdict' in receipt;
}

function taskLine(task: Task, run: Run | undefined): string {
  const runPart = run
    ? ` — ${run.kind} run \`${run.id}\`（${run.role}／${run.model_alias}，${run.state}，開始 ${run.started_at}）`
    : '';
  return `- \`${task.id}\` [${task.status}] ${clip(task.title, 80)}（${task.impl_role}）${runPart}`;
}

function receiptLine(run: Run): string {
  const receipt = run.receipt!;
  if (isReview(receipt)) {
    const mustFix = receipt.findings.filter((f) => f.severity === 'must_fix').length;
    return `- \`${run.task_id}\` \`${run.id}\` review：${receipt.verdict}（must_fix ${mustFix}）— ${clip(receipt.summary)}`;
  }
  const files =
    receipt.files_changed.length > 0 ? `（${receipt.files_changed.length} 個檔案）` : '';
  const leader =
    receipt.needs_leader !== '' ? `；需要 leader：${clip(receipt.needs_leader, 80)}` : '';
  return `- \`${run.task_id}\` \`${run.id}\` ${run.kind}：${receipt.status}${files} — ${clip(receipt.summary)}${leader}`;
}

function attentionLine(item: Attention): string {
  const task = item.task_id ? `（任務 \`${item.task_id}\`）` : '';
  const options = item.options.length > 0 ? ` — 選項：${item.options.join('／')}` : '';
  return `- \`${item.id}\` [${item.kind}]${task} ${clip(item.question)}${options}`;
}

function section(title: string, lines: string[], more = 0): string[] {
  const body = lines.length > 0 ? lines : ['（無）'];
  return [
    `## ${title}（${lines.length + more}）`,
    ...body,
    ...(more > 0 ? [`- …還有 ${more} 筆`] : []),
    '',
  ];
}

/** Markdown summary: tasks in progress, unread receipts, open attention items, other counts. */
export function resumeBrief(deps: { store: Store; clock: Clock }): string {
  const { store } = deps;
  const tasks = store.tasks.list();
  const runs = store.runs.list();
  const runById = new Map(runs.map((r) => [r.id, r]));
  const inProgress = tasks.filter((t) => (IN_PROGRESS as readonly string[]).includes(t.status));

  const cursor = store.kv.get(LEADER_RECEIPTS_CURSOR_KEY) ?? '';
  const unread = runs
    .filter((r) => r.receipt !== null && r.ended_at !== null && r.ended_at > cursor)
    .sort((a, b) => (a.ended_at! < b.ended_at! ? -1 : a.ended_at! > b.ended_at! ? 1 : 0));
  const shown = unread.slice(-MAX_RECEIPTS);

  const open = store.attention.list({ statuses: ['open'] });
  const count = (status: Task['status']) => tasks.filter((t) => t.status === status).length;
  const lastSeq = store.events.lastSeq();

  return [
    '# 現況摘要',
    '',
    `產生時間：${deps.clock.now().toISOString()}（事件游標 seq ${lastSeq}）`,
    '',
    ...section(
      '進行中的任務',
      inProgress.map((t) =>
        taskLine(t, t.current_run_id ? runById.get(t.current_run_id) : undefined),
      ),
    ),
    ...section('未讀回執', shown.map(receiptLine), unread.length - shown.length),
    ...section('待決事項', open.map(attentionLine)),
    '## 其他',
    `排隊 ${count('queued')}、草稿 ${count('draft')}、阻塞 ${count('blocked')}、失敗 ${count('failed')}、完成 ${count('done')}`,
    '',
  ].join('\n');
}
