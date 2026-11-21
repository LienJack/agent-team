import type { Run } from '@agent-team/client';
import { isLiveRun, sortRunsNewestFirst } from '../../lib/board.js';
import {
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
  RUN_KIND_LABELS,
  RUN_OUTCOME_LABELS,
  RUN_STATE_LABELS,
  usageTokens,
  type Tone,
} from '../../lib/format.js';
import { useNow } from '../../lib/now.js';
import { Badge } from '../ui/badge.js';
import { Empty } from '../ui/states.js';

const OUTCOME_TONE: Record<NonNullable<Run['outcome']>, Tone> = {
  ok: 'ok',
  rejected: 'bad',
  error: 'bad',
  rate_limited: 'warn',
  timeout: 'bad',
  cancelled: 'neutral',
};

/** Runs of the task, newest first; picking one shows its log tail. */
export function RunList({
  runs,
  selected,
  onSelect,
}: {
  runs: readonly Run[];
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const now = useNow();
  if (runs.length === 0) return <Empty>尚未執行</Empty>;
  return (
    <ul className="space-y-1.5" aria-label="Run 清單">
      {sortRunsNewestFirst(runs).map((run) => {
        const live = isLiveRun(run);
        const end = run.ended_at ? Date.parse(run.ended_at) : now;
        const tokens = usageTokens(run.usage);
        const outcome = run.outcome;
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              aria-pressed={selected === run.id}
              className={`w-full space-y-1 rounded-md border p-2 text-left ${selected === run.id ? 'border-accent bg-info-soft/40' : 'border-line hover:bg-raised'}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge>{RUN_KIND_LABELS[run.kind]}</Badge>
                <span className="truncate font-medium" title={`${run.model}（${run.runner}）`}>
                  {run.model_alias}
                </span>
                <span className="text-xs text-muted">{run.role}</span>
                <span className="ml-auto flex gap-1">
                  <Badge tone={live ? 'info' : 'neutral'}>
                    {live ? <span aria-hidden="true">▶</span> : null}
                    {RUN_STATE_LABELS[run.state]}
                  </Badge>
                  {outcome ? (
                    <Badge tone={OUTCOME_TONE[outcome]}>{RUN_OUTCOME_LABELS[outcome]}</Badge>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-muted tabular-nums">
                <span>開始 {formatTime(run.started_at)}</span>
                <span>耗時 {formatDuration(end - Date.parse(run.started_at))}</span>
                <span>費用 {formatCost(run.cost_usd)}</span>
                {tokens > 0 ? <span>用量 {formatTokens(tokens)} tok</span> : null}
              </div>
              {run.reject_reason || run.error ? (
                <p className="break-words text-xs text-bad">{run.reject_reason ?? run.error}</p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
