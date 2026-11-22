import type { MemoryItem, StateSnapshot } from '@agent-team/client';
import { MEMORY_SOURCE_LABEL } from '@agent-team/schema';
import { useState } from 'react';
import { errorLine } from '../api/errors.js';
import { useRemoveMemory } from '../api/mutations.js';
import { MEMORY_PAGE_SIZE, useProjectMemory } from '../api/queries.js';
import type { Tone } from '../lib/format.js';
import { useUi } from '../store/ui.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';
import { Empty, ErrorState, Loading } from './ui/states.js';

// The project memory of one project (spec §18): what the service stored in MemOS, newest first,
// with its source and date; a person can delete an item (after a confirmation). Items are
// written by the service only — there is no "add" here on purpose (`team memory add` exists).

const SOURCE_TONE: Record<NonNullable<MemoryItem['source']>, Tone> = {
  task: 'ok',
  decision: 'info',
  human: 'neutral',
  research: 'warn',
};

function SourceBadge({ item }: { item: MemoryItem }) {
  if (item.source === null) {
    return (
      <Badge tone="warn" title="這筆沒有 agent-team 的來源標記（可能被 MemOS 改寫過）：只當線索">
        來源未驗證
      </Badge>
    );
  }
  return <Badge tone={SOURCE_TONE[item.source]}>{MEMORY_SOURCE_LABEL[item.source]}</Badge>;
}

function ConfirmDelete({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: MemoryItem;
  onClose: () => void;
}) {
  const mutation = useRemoveMemory();
  return (
    <Dialog
      title="刪除這筆專案記憶？"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>返回</Button>
          <Button
            variant="danger"
            data-autofocus
            pending={mutation.isPending}
            onClick={() =>
              mutation.mutate({ projectId, memoryId: item.id }, { onSuccess: onClose })
            }
          >
            刪除
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="whitespace-pre-wrap break-words rounded-md bg-raised p-2 text-sm">
          {item.text}
        </p>
        <p className="text-muted">會從 MemOS 永久刪除，之後的派工不會再看到它；無法復原。</p>
        {mutation.isError ? (
          <p role="alert" className="rounded-md bg-bad-soft p-2 text-sm text-bad break-words">
            {errorLine(mutation.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function MemoryRow({ item, onDelete }: { item: MemoryItem; onDelete: () => void }) {
  const refs = [item.source_id ?? item.task_id, item.created_at?.slice(0, 10)].filter(Boolean);
  return (
    <li className="space-y-1.5 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge item={item} />
        {refs.length > 0 ? <span className="text-xs text-muted">{refs.join(' · ')}</span> : null}
        {item.searchable === false ? (
          <Badge tone="bad" title="MemOS 沒有為這筆建向量（MemOS #2461）：搜尋永遠找不到它">
            搜尋不到
          </Badge>
        ) : null}
        <Button
          size="sm"
          variant="danger"
          className="ml-auto"
          aria-label={`刪除記憶 ${item.id}`}
          onClick={onDelete}
        >
          刪除
        </Button>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>
    </li>
  );
}

/** The project memory dialog (top bar → 專案記憶). */
export function MemoryPanel({ state }: { state: StateSnapshot }) {
  const setMemoryOpen = useUi((s) => s.setMemoryOpen);
  const projectFilter = useUi((s) => s.projectFilter);
  const [projectId, setProjectId] = useState(projectFilter ?? state.projects[0]?.id);
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<MemoryItem | undefined>();
  const memory = useProjectMemory(projectId, page);
  const pages = memory.data ? Math.max(1, Math.ceil(memory.data.total / MEMORY_PAGE_SIZE)) : 1;
  const close = () => setMemoryOpen(false);

  return (
    <Dialog title="專案記憶" variant="sheet" onClose={close}>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          服務端在任務完成、人回答待決事項、調研完成或手動加入時寫入（存在
          MemOS）；派工前會依派工單搜尋， 結果以資料區塊附在提示裡。調研的內容源自網頁。
        </p>
        {state.projects.length > 1 ? (
          <select
            aria-label="專案"
            value={projectId ?? ''}
            onChange={(e) => {
              setProjectId(e.target.value);
              setPage(1);
            }}
            className="h-8 rounded-md border border-line bg-surface px-1 text-sm"
          >
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        {projectId === undefined ? (
          <Empty>還沒有專案</Empty>
        ) : memory.isPending ? (
          <Loading label="讀取專案記憶…" />
        ) : memory.isError ? (
          <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
        ) : memory.data.memories.length === 0 ? (
          <Empty>這個專案還沒有記憶</Empty>
        ) : (
          <>
            <ul aria-label="記憶清單" className="space-y-2">
              {memory.data.memories.map((item) => (
                <MemoryRow key={item.id} item={item} onDelete={() => setDeleting(item)} />
              ))}
            </ul>
            <div className="flex items-center justify-between text-xs text-muted">
              <span>
                第 {page}/{pages} 頁，共 {memory.data.total} 筆
              </span>
              <span className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  上一頁
                </Button>
                <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  下一頁
                </Button>
              </span>
            </div>
          </>
        )}
      </div>
      {deleting && projectId !== undefined ? (
        <ConfirmDelete
          projectId={projectId}
          item={deleting}
          onClose={() => setDeleting(undefined)}
        />
      ) : null}
    </Dialog>
  );
}
