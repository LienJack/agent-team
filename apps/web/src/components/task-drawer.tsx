import type { StateSnapshot, TaskDetail } from '@agent-team/client';
import { useState, type ReactNode } from 'react';
import { useTaskDetail } from '../api/queries.js';
import { isLiveRun, latestReceiptRun, latestReviewRun, sortRunsNewestFirst } from '../lib/board.js';
import { formatTime, RUN_KIND_LABELS, shortSha } from '../lib/format.js';
import { Markdown } from '../lib/markdown.js';
import { useUi } from '../store/ui.js';
import { FindingsList, isReviewReceipt, ReceiptView } from './drawer/receipt-view.js';
import { LogTail } from './drawer/log-tail.js';
import { RunList } from './drawer/run-list.js';
import { TaskActions } from './drawer/task-actions.js';
import { Badge, StatusBadge } from './ui/badge.js';
import { Dialog } from './ui/dialog.js';
import { Empty, ErrorState, Loading } from './ui/states.js';

function Section({
  title,
  id,
  children,
}: {
  title: string;
  /** An identifier shown after the title as is (never upper-cased: ids are case-sensitive). */
  id?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold tracking-wide text-muted">
        <span className="uppercase">{title}</span>
        {id ? <span className="font-mono normal-case">（{id}）</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function DrawerBody({ detail, projectName }: { detail: TaskDetail; projectName: string }) {
  const { task, runs, workspace } = detail;
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const newest = sortRunsNewestFirst(runs)[0];
  const selectedRun = runs.find((r) => r.id === picked) ?? newest;
  const receiptRun = latestReceiptRun(runs);
  const reviewRun = latestReviewRun(runs);
  const review =
    reviewRun?.receipt && isReviewReceipt(reviewRun.receipt) ? reviewRun.receipt : undefined;
  const openAttention = detail.attention.filter((a) => a.status === 'open');

  return (
    <div className="space-y-4">
      <Section title="操作">
        <TaskActions task={task} />
      </Section>

      <Section title="概要">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Field label="專案">{projectName}</Field>
          <Field label="Tier">{task.tier}</Field>
          <Field label="角色">{task.impl_role}</Field>
          <Field label="嘗試 / 修正輪">
            {task.attempts} / {task.fix_rounds}
          </Field>
          <Field label="commit">
            <span className="font-mono" title={workspace?.head_sha ?? undefined}>
              {shortSha(workspace?.head_sha)}
            </span>
          </Field>
          <Field label="更新">{formatTime(task.updated_at)}</Field>
        </dl>
        <div>
          <p className="text-xs text-muted">owned_paths</p>
          <ul className="flex flex-wrap gap-1">
            {task.owned_paths.map((p) => (
              <li key={p}>
                <code className="rounded bg-raised px-1 font-mono text-xs break-all">{p}</code>
              </li>
            ))}
          </ul>
        </div>
        {task.blocked_reason ? (
          <p className="rounded-md bg-bad-soft p-2 text-bad break-words">
            <span aria-hidden="true">■ </span>阻塞原因：{task.blocked_reason}
          </p>
        ) : null}
        {task.fix_notes ? (
          <div className="rounded-md bg-warn-soft p-2 text-warn">
            <p className="text-xs font-semibold">修正單</p>
            <p className="break-words whitespace-pre-wrap">{task.fix_notes}</p>
          </div>
        ) : null}
        {openAttention.length > 0 ? (
          <p className="text-warn">
            <span aria-hidden="true">◆ </span>有 {openAttention.length}{' '}
            筆待決事項，請在「待決事項」回答。
          </p>
        ) : null}
      </Section>

      <Section title="派工單">
        <Markdown source={task.ticket_md} />
      </Section>

      <Section title="最新回執">
        {receiptRun?.receipt ? (
          <>
            <p className="text-xs text-muted">
              {RUN_KIND_LABELS[receiptRun.kind]} · {receiptRun.model_alias} ·{' '}
              {formatTime(receiptRun.ended_at)}
            </p>
            <ReceiptView receipt={receiptRun.receipt} />
          </>
        ) : (
          <Empty>還沒有回執</Empty>
        )}
      </Section>

      <Section title="審查發現">
        {review ? <FindingsList findings={review.findings} /> : <Empty>還沒有審查</Empty>}
      </Section>

      <Section title="Run 清單">
        <RunList runs={runs} selected={selectedRun?.id} onSelect={setPicked} />
      </Section>

      <Section title="日誌尾段" id={selectedRun?.id}>
        <LogTail runId={selectedRun?.id} live={selectedRun ? isLiveRun(selectedRun) : false} />
      </Section>
    </div>
  );
}

/** Card drawer (spec §13): ticket, receipt, findings, runs, log tail and actions. */
export function TaskDrawer({ state }: { state: StateSnapshot | undefined }) {
  const taskId = useUi((s) => s.selectedTaskId);
  const openTask = useUi((s) => s.openTask);
  const detail = useTaskDetail(taskId);
  if (taskId === undefined) return null;
  const task = detail.data?.task ?? state?.tasks.find((t) => t.id === taskId);
  const projectName =
    state?.projects.find((p) => p.id === task?.project_id)?.name ?? task?.project_id ?? '';

  return (
    <Dialog
      variant="sheet"
      onClose={() => openTask(undefined)}
      title={task?.title ?? taskId}
      headerExtra={
        task ? (
          <span className="flex shrink-0 gap-1">
            <StatusBadge status={task.status} />
            <Badge>Tier {task.tier}</Badge>
          </span>
        ) : null
      }
    >
      <p className="mb-3 font-mono text-xs text-muted">{taskId}</p>
      {detail.isPending ? <Loading /> : null}
      {detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : null}
      {detail.data ? (
        <DrawerBody key={taskId} detail={detail.data} projectName={projectName} />
      ) : null}
    </Dialog>
  );
}
