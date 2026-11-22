import type { Run } from '@agent-team/client';
import { Markdown } from '../../lib/markdown.js';
import type { Tone } from '../../lib/format.js';
import { Badge } from '../ui/badge.js';
import { Empty } from '../ui/states.js';
import { ResearchReceiptView } from './research-view.js';

// The three receipt shapes, told apart by a field only they have (a research receipt also has
// `status`, so `'status' in r` does not mean "impl"; same rule as @agent-team/schema's guards).
export type Receipt = NonNullable<Run['receipt']>;
export type ImplReceipt = Extract<Receipt, { files_changed: unknown }>;
export type ReviewReceipt = Extract<Receipt, { verdict: unknown }>;
export type ResearchReceipt = Extract<Receipt, { candidates: unknown }>;

export function isImplReceipt(r: Receipt): r is ImplReceipt {
  return 'files_changed' in r;
}
export function isReviewReceipt(r: Receipt): r is ReviewReceipt {
  return 'verdict' in r;
}
export function isResearchReceipt(r: Receipt): r is ResearchReceipt {
  return 'candidates' in r;
}

const IMPL_STATUS: Record<ImplReceipt['status'], [string, Tone]> = {
  done: ['完成', 'ok'],
  blocked: ['阻塞', 'bad'],
  failed: ['失敗', 'bad'],
};
const VERDICT: Record<ReviewReceipt['verdict'], [string, Tone]> = {
  pass: ['通過', 'ok'],
  needs_changes: ['需要修改', 'warn'],
  blocked: ['阻塞', 'bad'],
};
const CHECK: Record<ImplReceipt['checks'][number]['result'], [string, Tone, string]> = {
  pass: ['通過', 'ok', '✓'],
  fail: ['失敗', 'bad', '✕'],
  not_run: ['未執行', 'neutral', '–'],
};
const SEVERITY: Record<ReviewReceipt['findings'][number]['severity'], [string, Tone]> = {
  must_fix: ['必改', 'bad'],
  should_fix: ['建議', 'warn'],
  note: ['備註', 'neutral'],
};

function ImplReceiptView({ receipt }: { receipt: ImplReceipt }) {
  const [label, tone] = IMPL_STATUS[receipt.status];
  return (
    <div className="space-y-2">
      <Badge tone={tone}>實作回執：{label}</Badge>
      <Markdown source={receipt.summary} />
      {receipt.needs_leader ? (
        <p className="rounded-md bg-warn-soft p-2 text-warn break-words">
          需要 leader：{receipt.needs_leader}
        </p>
      ) : null}
      <div>
        <h4 className="text-xs font-semibold text-muted">自述變更檔案（以 git 為準）</h4>
        {receipt.files_changed.length === 0 ? (
          <Empty>無</Empty>
        ) : (
          <ul className="font-mono text-xs">
            {receipt.files_changed.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
      {receipt.checks.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold text-muted">自述檢查</h4>
          <ul className="space-y-1 text-xs">
            {receipt.checks.map((c, i) => {
              const [text, t, icon] = CHECK[c.result];
              return (
                <li key={`${c.cmd}-${i}`} className="flex min-w-0 items-start gap-2">
                  <Badge tone={t}>
                    <span aria-hidden="true">{icon}</span>
                    {text}
                  </Badge>
                  <span className="min-w-0 break-words">
                    <code className="font-mono">{c.cmd}</code>
                    {c.note ? <span className="text-muted"> — {c.note}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function FindingsList({ findings }: { findings: ReviewReceipt['findings'] }) {
  if (findings.length === 0) return <Empty>沒有審查發現</Empty>;
  return (
    <ul className="space-y-1.5">
      {findings.map((f, i) => {
        const [label, tone] = SEVERITY[f.severity];
        const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
        return (
          <li key={`${where}-${i}`} className="space-y-0.5 rounded-md border border-line p-2">
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone={tone}>{label}</Badge>
              <code className="truncate font-mono text-xs" title={where}>
                {where}
              </code>
            </div>
            <p className="break-words whitespace-pre-wrap">{f.issue}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function ReceiptView({ receipt }: { receipt: Receipt }) {
  if (isResearchReceipt(receipt)) return <ResearchReceiptView receipt={receipt} />;
  if (isImplReceipt(receipt)) return <ImplReceiptView receipt={receipt} />;
  const [label, tone] = VERDICT[receipt.verdict];
  return (
    <div className="space-y-2">
      <Badge tone={tone}>審查回執：{label}</Badge>
      <Markdown source={receipt.summary} />
    </div>
  );
}
