import type { StateSnapshot } from '@agent-team/client';
import { useBoardState } from '../api/queries.js';
import { useEventStream } from '../realtime/use-event-stream.js';
import { useUi, type MobileView } from '../store/ui.js';
import { AttentionPanel } from './attention-panel.js';
import { Board } from './board.js';
import { ChatPanel } from './chat-panel.js';
import { MemoryPanel } from './memory-panel.js';
import { NewTaskForm } from './new-task-form.js';
import { TaskDrawer } from './task-drawer.js';
import { useApplyTheme } from './theme.js';
import { TopBar } from './top-bar.js';
import { ErrorState, Loading } from './ui/states.js';
import { Toasts } from './ui/toasts.js';

function ViewTabs({ state, sideOnly }: { state: StateSnapshot | undefined; sideOnly?: boolean }) {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const count = state?.open_attention.length ?? 0;
  const tabs: Array<{ id: MobileView; label: string }> = sideOnly
    ? [
        { id: 'attention', label: `待決事項（${count}）` },
        { id: 'chat', label: '聊天' },
      ]
    : [
        { id: 'board', label: '看板' },
        { id: 'attention', label: `待決（${count}）` },
        { id: 'chat', label: '聊天' },
      ];
  const current = sideOnly && view === 'board' ? 'attention' : view;
  return (
    <nav aria-label={sideOnly ? '側欄' : '檢視'} className="flex gap-1 rounded-md bg-raised p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setView(t.id)}
          aria-current={current === t.id ? 'page' : undefined}
          className={`h-8 flex-1 rounded px-2 text-sm ${current === t.id ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-fg'}`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

function Shell() {
  const view = useUi((s) => s.view);
  const newTaskOpen = useUi((s) => s.newTaskOpen);
  const memoryOpen = useUi((s) => s.memoryOpen);
  // the LAN listener has no login (docs/adr/0024): the board loads straight away
  const state = useBoardState();
  const data = state.data;
  useApplyTheme();
  useEventStream(data?.last_seq);

  if (!data) {
    return (
      <main className="mx-auto max-w-md p-6">
        {state.isError ? (
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        ) : (
          <Loading label="讀取看板…" />
        )}
      </main>
    );
  }

  const sideTab = view === 'chat' ? 'chat' : 'attention';
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar state={data} />
      <div className="px-3 pt-2 md:max-w-md 2xl:hidden">
        <ViewTabs state={data} />
      </div>
      {state.isError ? (
        <div className="px-3 pt-2">
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col 2xl:flex-row">
        <main
          aria-label="看板"
          className={`min-w-0 2xl:flex-1 ${view === 'board' ? '' : 'hidden 2xl:block'}`}
        >
          <Board state={data} />
        </main>
        <aside
          aria-label={sideTab === 'chat' ? '聊天' : '待決事項'}
          className={`w-full max-w-2xl flex-col gap-3 self-center border-line p-3 2xl:sticky 2xl:top-24 2xl:flex 2xl:max-h-[calc(100dvh-6rem)] 2xl:w-96 2xl:shrink-0 2xl:self-start 2xl:overflow-y-auto 2xl:border-l ${view === 'board' ? 'hidden' : 'flex'}`}
        >
          <div className="hidden 2xl:block">
            <ViewTabs state={data} sideOnly />
          </div>
          <h2 className="text-sm font-semibold 2xl:sr-only">
            {sideTab === 'chat' ? '與 Leader 對話' : '待決事項'}
          </h2>
          {sideTab === 'chat' ? <ChatPanel state={data} /> : <AttentionPanel state={data} />}
        </aside>
      </div>
      <TaskDrawer state={data} />
      {newTaskOpen ? <NewTaskForm state={data} /> : null}
      {memoryOpen && data.memory_enabled ? <MemoryPanel state={data} /> : null}
      <Toasts />
    </div>
  );
}

export function App() {
  return <Shell />;
}
