import type { Task } from '@agent-team/client';
import { isPermissiveLicense, researchUrlProblem } from '@agent-team/schema';
import type { Tone } from '../../lib/format.js';
import { useUi } from '../../store/ui.js';
import { Badge } from '../ui/badge.js';
import { Empty } from '../ui/states.js';
import type { ResearchReceipt } from './receipt-view.js';

// A research receipt (spec §17). Its text comes from a model that read untrusted web pages: all
// of it is rendered as plain text (no Markdown, so no autolinks either), and a candidate's name
// is a link only for an https URL. The service never fetched those URLs, which the board says.

export const UNVERIFIED_LINKS_NOTE = '連結未經服務端驗證';

const STATUS: Record<ResearchReceipt['status'], [string, Tone]> = {
  done: ['完成', 'ok'],
  blocked: ['阻塞', 'bad'],
  failed: ['失敗', 'bad'],
};

export const RECOMMENDATION_LABELS: Record<ResearchReceipt['recommendation'], string> = {
  adopt_dependency: '直接採用為依賴',
  adapt_pattern: '參考做法自行實作',
  reference_only: '只當參考',
  build_from_scratch: '沒有合適的，自行實作',
};

const FIT: Record<ResearchReceipt['candidates'][number]['fit'], [string, Tone]> = {
  high: ['高', 'ok'],
  medium: ['中', 'warn'],
  low: ['低', 'neutral'],
};

/** The href for a candidate link, or undefined (https only, no credentials; never followed). */
export function candidateHref(url: string): string | undefined {
  return url.startsWith('https://') && researchUrlProblem(url) === null ? url : undefined;
}

function Candidate({ candidate }: { candidate: ResearchReceipt['candidates'][number] }) {
  const href = candidateHref(candidate.url);
  const [fit, fitTone] = FIT[candidate.fit];
  const permissive = isPermissiveLicense(candidate.license);
  return (
    <li className="space-y-1 rounded-md border border-line p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium break-all text-accent underline underline-offset-2"
          >
            {candidate.name}
          </a>
        ) : (
          <span className="font-medium break-all">{candidate.name}</span>
        )}
        <Badge
          tone={permissive ? 'neutral' : 'warn'}
          title={permissive ? '寬鬆授權' : '非寬鬆授權或不明：只能參考做法，不可複製程式碼'}
        >
          授權 {candidate.license}
        </Badge>
        <Badge tone={fitTone}>適合度 {fit}</Badge>
      </div>
      <p className="font-mono text-xs break-all text-muted">{candidate.url}</p>
      {candidate.borrow ? (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-xs font-semibold text-muted">值得參考：</span>
          {candidate.borrow}
        </p>
      ) : null}
      {candidate.caveats ? (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-xs font-semibold text-muted">注意：</span>
          {candidate.caveats}
        </p>
      ) : null}
    </li>
  );
}

export function ResearchReceiptView({ receipt }: { receipt: ResearchReceipt }) {
  const [label, tone] = STATUS[receipt.status];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={tone}>調研回執：{label}</Badge>
        <Badge tone="info" title={receipt.recommendation}>
          建議：{RECOMMENDATION_LABELS[receipt.recommendation]}
        </Badge>
      </div>
      {receipt.summary ? (
        <p className="break-words whitespace-pre-wrap">{receipt.summary}</p>
      ) : null}
      {receipt.needs_leader ? (
        <p className="rounded-md bg-warn-soft p-2 break-words whitespace-pre-wrap text-warn">
          需要 leader：{receipt.needs_leader}
        </p>
      ) : null}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-muted">候選（{receipt.candidates.length}）</h4>
        <p className="text-xs text-warn">{UNVERIFIED_LINKS_NOTE}</p>
        {receipt.candidates.length === 0 ? (
          <Empty>沒有候選</Empty>
        ) : (
          <ul className="space-y-1.5" aria-label="候選清單">
            {receipt.candidates.map((c, i) => (
              <Candidate key={`${c.name}-${i}`} candidate={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The research tasks an impl task cites (spec §17), titles from the board snapshot. */
export function CitedResearch({
  refs,
  tasks,
}: {
  refs: readonly string[];
  tasks: ReadonlyArray<Pick<Task, 'id' | 'title'>> | undefined;
}) {
  const openTask = useUi((s) => s.openTask);
  if (refs.length === 0) return null;
  return (
    <div>
      <p className="text-xs text-muted">參考調研：</p>
      <ul className="space-y-0.5" aria-label="參考調研">
        {refs.map((id) => {
          const title = tasks?.find((t) => t.id === id)?.title;
          return (
            <li key={id} className="min-w-0">
              <button
                type="button"
                onClick={() => openTask(id)}
                className="max-w-full truncate text-left hover:underline"
                title={title ? `${title}（${id}）` : id}
              >
                {title ?? id}
                {title ? <span className="font-mono text-xs text-muted">（{id}）</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
