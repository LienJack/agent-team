import type { RunnerStatus, StateSnapshot } from '@agent-team/client';
import type { ReactNode } from 'react';
import { formatPercent, type Tone } from '../lib/format.js';
import { useNow } from '../lib/now.js';
import { describeRunner, LEADER_LABELS, sortRunners } from '../lib/runners.js';
import { useUi, type Connection } from '../store/ui.js';
import { ThemeToggle } from './theme.js';
import { TONE_CLASSES } from './ui/badge.js';
import { Button } from './ui/button.js';

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted',
  info: 'bg-info',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

const CONNECTION: Record<Connection, { label: string; tone: Tone; icon: string }> = {
  idle: { label: '未連線', tone: 'neutral', icon: '○' },
  connecting: { label: '連線中…', tone: 'info', icon: '◌' },
  live: { label: '即時', tone: 'ok', icon: '●' },
  reconnecting: { label: '重新連線中…', tone: 'warn', icon: '◌' },
  offline: { label: '已離線', tone: 'bad', icon: '✕' },
};

function Chip({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

function RunnerChip({ runner, now }: { runner: RunnerStatus; now: number }) {
  const view = describeRunner(runner, now);
  return (
    <Chip tone={view.tone} title={view.detail}>
      <span className="font-medium">{view.name}</span>
      <span>{view.label}</span>
      {view.utilization !== undefined ? (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="h-1.5 w-8 overflow-hidden rounded bg-line">
            <span
              className={`block h-full ${DOT[view.utilization >= 0.9 ? 'bad' : view.utilization >= 0.7 ? 'warn' : 'ok']}`}
              style={{ width: `${Math.round(Math.min(1, view.utilization) * 100)}%` }}
            />
          </span>
          <span>{formatPercent(view.utilization)}</span>
        </span>
      ) : null}
      <span className="sr-only">{view.detail}</span>
    </Chip>
  );
}

export function ConnectionIndicator() {
  const connection = useUi((s) => s.connection);
  const c = CONNECTION[connection];
  return (
    <span role="status" aria-label={`即時連線：${c.label}`}>
      <Chip tone={c.tone}>
        <span aria-hidden="true">{c.icon}</span>
        {c.label}
      </Chip>
    </span>
  );
}

export function TopBar({ state }: { state: StateSnapshot | undefined }) {
  const now = useNow();
  const setView = useUi((s) => s.setView);
  const setNewTaskOpen = useUi((s) => s.setNewTaskOpen);
  const setMemoryOpen = useUi((s) => s.setMemoryOpen);
  const projectFilter = useUi((s) => s.projectFilter);
  const setProjectFilter = useUi((s) => s.setProjectFilter);
  const leader = state ? LEADER_LABELS[state.leader.state] : undefined;
  const openCount = state?.open_attention.length ?? 0;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h1 className="mr-1 text-sm font-semibold">agent-team</h1>
        {leader ? (
          <Chip
            tone={leader.tone}
            title={`Leader：${leader.label}${state?.leader.hint ? `（${state.leader.hint}）` : ''}`}
          >
            <span aria-hidden="true" className={`size-2 rounded-full ${DOT[leader.tone]}`} />
            Leader {leader.label}
          </Chip>
        ) : null}
        <button
          type="button"
          onClick={() => setView('attention')}
          aria-label={`未決事項 ${openCount} 筆`}
          className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs ${TONE_CLASSES[openCount > 0 ? 'warn' : 'neutral']}`}
        >
          <span aria-hidden="true">{openCount > 0 ? '◆' : '◇'}</span>
          未決 {openCount}
        </button>
        <ConnectionIndicator />
        <div className="ml-auto flex items-center gap-2">
          {state && state.projects.length > 1 ? (
            <select
              aria-label="篩選專案"
              value={projectFilter ?? ''}
              onChange={(e) => setProjectFilter(e.target.value === '' ? undefined : e.target.value)}
              className="h-8 max-w-32 rounded-md border border-line bg-surface px-1 text-xs"
            >
              <option value="">全部專案</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
          <ThemeToggle />
          {state?.memory_enabled ? (
            <Button size="sm" onClick={() => setMemoryOpen(true)}>
              專案記憶
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => setNewTaskOpen(true)}>
            ＋ 新增任務
          </Button>
        </div>
      </div>
      {state ? (
        <div aria-label="Runner 狀態" role="group" className="flex gap-2 overflow-x-auto px-3 pb-2">
          {state.runners.length === 0 ? (
            <span className="text-xs text-muted">沒有 runner 資料</span>
          ) : (
            sortRunners(state.runners).map((r) => (
              <RunnerChip key={r.runner} runner={r} now={now} />
            ))
          )}
        </div>
      ) : null}
    </header>
  );
}
