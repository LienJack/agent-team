import { LOG_TAIL_LINES, useRunLog } from '../../api/queries.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

/** Last lines of a run's log (GET /api/runs/:id/log?tail=), as plain text. */
export function LogTail({ runId, live }: { runId: string | undefined; live: boolean }) {
  const log = useRunLog(runId, live);
  if (runId === undefined) return <Empty>選一個 run 查看日誌</Empty>;
  if (log.isPending) return <Loading label="讀取日誌…" />;
  if (log.isError) return <ErrorState error={log.error} onRetry={() => void log.refetch()} />;
  const { lines, truncated } = log.data;
  if (lines.length === 0) return <Empty>日誌是空的</Empty>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">
        {truncated ? `只顯示最後 ${LOG_TAIL_LINES} 行` : `共 ${lines.length} 行`}
        {live ? '（執行中，每 3 秒更新）' : ''}
      </p>
      <pre
        tabIndex={0}
        aria-label="日誌尾段"
        className="max-h-80 overflow-auto rounded-md bg-raised p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all"
      >
        {lines.join('\n')}
      </pre>
    </div>
  );
}
