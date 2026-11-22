import type { BoardTask } from '@agent-team/client';
import { Draggable } from '@hello-pangea/dnd';
import { memo } from 'react';
import { summarizeTask } from '../lib/board.js';
import {
  EMPTY,
  formatCost,
  formatDuration,
  formatTokens,
  shortSha,
  waitingText,
} from '../lib/format.js';
import { useNow } from '../lib/now.js';
import { useUi } from '../store/ui.js';
import { Badge, StatusBadge } from './ui/badge.js';

function Meta({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string | undefined;
}) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1" title={title ?? `${label} ${value}`}>
      {/* the label never wraps (CJK text would break per character in a narrow cell) */}
      <span className="shrink-0 whitespace-nowrap text-muted">{label}</span>
      <span className="min-w-0 truncate font-mono tabular-nums">{value}</span>
    </span>
  );
}

/** Live parts of a card, from the snapshot alone (re-render every second while a run is live). */
function CardMeta({ task }: { task: BoardTask }) {
  const now = useNow();
  const s = summarizeTask(task, now);
  // a research task (spec §17) has no tier, worktree or commit
  const research = task.kind === 'research';
  const refs = task.research_refs.length;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <StatusBadge status={task.status} />
        {research ? (
          <Badge tone="info" title="調研任務：查可參考的開源專案">
            調研
          </Badge>
        ) : (
          <Badge title={`Tier ${task.tier}`}>Tier {task.tier}</Badge>
        )}
        <Badge title={s.executorDetail ?? `角色 ${task.impl_role}（尚未執行）`} className="min-w-0">
          <span aria-hidden="true">⚙</span>
          <span className="truncate">{s.executor ?? task.impl_role}</span>
        </Badge>
        {!research && refs > 0 ? (
          <span
            className="text-xs whitespace-nowrap text-muted"
            title={`參考調研：${task.research_refs.join('、')}`}
          >
            參考 {refs}
          </span>
        ) : null}
      </div>
      {s.elapsedMs === undefined && s.commit === null ? (
        <p className="text-xs text-muted">尚未執行</p>
      ) : (
        // two columns when the card is wide enough, one when it is not (narrow board columns
        // next to the 2xl side panel clipped "用量 321.4k tok"; 2026-11-21 screenshots)
        <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-x-2 gap-y-0.5 text-xs">
          <Meta
            label={s.liveSince ? '執行' : '耗時'}
            value={s.elapsedMs === undefined ? EMPTY : formatDuration(s.elapsedMs)}
          />
          <Meta label="費用" value={formatCost(s.costUsd, s.costEstimated)} />
          <Meta label="用量" value={s.tokens > 0 ? `${formatTokens(s.tokens)} tok` : EMPTY} />
          {research ? null : (
            <Meta label="commit" value={shortSha(s.commit)} title={s.commit ?? undefined} />
          )}
        </div>
      )}
    </>
  );
}

export const TaskCard = memo(function TaskCard({
  task,
  index,
}: {
  task: BoardTask;
  index: number;
}) {
  const openTask = useUi((s) => s.openTask);
  return (
    <Draggable draggableId={task.id} index={index}>
      {(provided, snapshot) => (
        <li
          ref={provided.innerRef}
          {...provided.draggableProps}
          data-task-id={task.id}
          className={`space-y-1.5 rounded-md border bg-surface p-2.5 shadow-sm ${snapshot.isDragging ? 'border-accent shadow-lg' : 'border-line'}`}
        >
          <div className="flex min-w-0 items-start gap-1.5">
            {/* separate grip: the drag handle (role=button from the library) must not contain the
                title button; keyboard: Tab to the grip, Space to lift, arrows, Space to drop */}
            <span
              {...provided.dragHandleProps}
              aria-label={`拖曳：${task.title}`}
              title="拖曳以移動（空白鍵拿起／放下）"
              className="-ml-1 cursor-grab rounded px-1 leading-5 text-muted select-none hover:bg-raised hover:text-fg"
            >
              <span aria-hidden="true">⠿</span>
            </span>
            <button
              type="button"
              onClick={() => openTask(task.id)}
              title={task.title}
              className="block min-w-0 flex-1 truncate text-left text-sm leading-5 font-medium hover:underline"
            >
              {task.title}
            </button>
          </div>
          <CardMeta task={task} />
          {task.waiting ? (
            <p className="truncate text-xs text-warn" title={waitingText(task.waiting)}>
              <span aria-hidden="true">⏸ </span>
              {waitingText(task.waiting)}
            </p>
          ) : null}
          {task.blocked_reason ? (
            <p className="truncate text-xs text-bad" title={task.blocked_reason}>
              <span aria-hidden="true">■ </span>
              {task.blocked_reason}
            </p>
          ) : null}
        </li>
      )}
    </Draggable>
  );
});
