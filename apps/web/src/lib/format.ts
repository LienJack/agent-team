import type { Run } from '@agent-team/client';
import type { TaskStatus } from '@agent-team/schema';

// Display formatters (zh-Hant). Pure, so they are unit tested and reused by every panel.

export const EMPTY = '—';

/** Compact duration: 45 秒, 3 分 12 秒, 1 小時 5 分, 2 天 3 小時. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EMPTY;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} 分` : `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} 小時` : `${h} 小時 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} 天` : `${d} 天 ${h % 24} 小時`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return EMPTY;
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** 950 → 950, 12_300 → 12.3k, 1_250_000 → 1.3M. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EMPTY;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Share 0..1 → "45%" (clamped). */
export function formatPercent(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return EMPTY;
  return `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : EMPTY;
}

/** Input + output tokens of one usage record (cache and reasoning are shown in the drawer). */
export function usageTokens(usage: Run['usage']): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

const timeFmt = new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Local time; the date is added when `iso` is not on the same day as `now`. */
export function formatTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return date.toDateString() === now.toDateString()
    ? timeFmt.format(date)
    : dateTimeFmt.format(date);
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  queued: '排隊中',
  running: '執行中',
  verifying: '核對中',
  review: '待驗收',
  done: '完成',
  blocked: '阻塞',
  failed: '失敗',
  cancelled: '已取消',
};

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad';

export const STATUS_TONES: Record<TaskStatus, Tone> = {
  draft: 'neutral',
  queued: 'neutral',
  running: 'info',
  verifying: 'info',
  review: 'warn',
  done: 'ok',
  blocked: 'bad',
  failed: 'bad',
  cancelled: 'neutral',
};

export const RUN_STATE_LABELS: Record<Run['state'], string> = {
  starting: '啟動中',
  running: '執行中',
  succeeded: '已結束',
  failed: '失敗',
  start_unknown: '啟動不明',
  stopped: '已停止',
  abandoned: '已放棄',
};

export const RUN_OUTCOME_LABELS: Record<NonNullable<Run['outcome']>, string> = {
  ok: '通過',
  rejected: '核對未過',
  error: '錯誤',
  rate_limited: '額度限制',
  timeout: '逾時',
  cancelled: '已取消',
};

export const RUN_KIND_LABELS: Record<Run['kind'], string> = {
  impl: '實作',
  fix: '修正',
  review: '審查',
};
