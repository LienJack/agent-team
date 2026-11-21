import type { BoardTask, StateSnapshot, Task } from '@agent-team/client';
import { BOARD_COLUMNS, type BoardColumnId } from '@agent-team/schema';
import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd';
import { useCallback, useMemo, useState } from 'react';
import { useTaskAction } from '../api/mutations.js';
import { groupTasks } from '../lib/board.js';
import { useUi } from '../store/ui.js';
import { handleDrop } from './board-drop.js';
import { ConfirmAction } from './confirm-action.js';
import { TaskCard } from './task-card.js';
import { Empty } from './ui/states.js';

const DONE_VISIBLE = 20;

const HINTS: Record<BoardColumnId, string> = {
  pending: '草稿、排隊中',
  in_progress: '執行中、核對中',
  review: '等待審查或人工驗收',
  blocked: '阻塞、失敗',
  done: '已完成',
};

function Column({ id, label, tasks }: { id: BoardColumnId; label: string; tasks: BoardTask[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = id === 'done' && !showAll ? tasks.slice(0, DONE_VISIBLE) : tasks;
  const headingId = `col-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col rounded-lg border border-line bg-raised/60 md:min-w-56 md:flex-1 md:basis-0"
    >
      <header className="flex items-baseline gap-2 px-3 pt-2 pb-1">
        <h2 id={headingId} className="text-sm font-semibold">
          {label}
        </h2>
        <span className="text-xs text-muted" aria-label={`${tasks.length} 個任務`}>
          {tasks.length}
        </span>
        <span className="ml-auto truncate text-xs text-muted">{HINTS[id]}</span>
      </header>
      <Droppable droppableId={id}>
        {(provided, snapshot) => (
          <ul
            ref={provided.innerRef}
            {...provided.droppableProps}
            data-column={id}
            className={`flex min-h-16 flex-1 flex-col gap-2 p-2 ${snapshot.isDraggingOver ? 'bg-info-soft/60' : ''}`}
          >
            {visible.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} />
            ))}
            {provided.placeholder}
            {tasks.length === 0 && !snapshot.isDraggingOver ? (
              <li className="list-none">
                <Empty>沒有任務</Empty>
              </li>
            ) : null}
          </ul>
        )}
      </Droppable>
      {id === 'done' && tasks.length > DONE_VISIBLE ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="m-2 mt-0 rounded-md px-2 py-1 text-xs text-accent hover:bg-surface"
        >
          {showAll ? '只顯示最近的' : `顯示全部（${tasks.length}）`}
        </button>
      ) : null}
    </section>
  );
}

/** The five columns (spec §5, §13). Drops only call the API; the board re-renders from it. */
export function Board({ state }: { state: StateSnapshot }) {
  const projectFilter = useUi((s) => s.projectFilter);
  const toast = useUi((s) => s.toast);
  const { mutate } = useTaskAction();
  const [confirm, setConfirm] = useState<{ task: Task; action: 'approve' | 'reject' } | null>(null);

  const columns = useMemo(
    () => groupTasks(state.tasks, projectFilter),
    [state.tasks, projectFilter],
  );
  const tasksById = useMemo(() => new Map(state.tasks.map((t) => [t.id, t])), [state.tasks]);

  const onDragEnd = useCallback(
    (result: DropResult) => {
      handleDrop(tasksById, result.draggableId, result.destination?.droppableId, {
        explain: (reason) => toast('info', reason),
        run: (task, kind) => mutate({ id: task.id, action: kind }),
        confirm: (task, kind) => setConfirm({ task, action: kind }),
      });
    },
    [tasksById, toast, mutate],
  );

  return (
    <>
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 gap-3 p-3 md:flex md:items-start md:overflow-x-auto">
          {BOARD_COLUMNS.map((c) => (
            <Column key={c.id} id={c.id} label={c.label} tasks={columns[c.id]} />
          ))}
        </div>
      </DragDropContext>
      {confirm ? (
        <ConfirmAction
          task={confirm.task}
          action={confirm.action}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
