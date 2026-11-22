import type { RunnerStatus, StateSnapshot } from '@agent-team/client';
import { formatPercent, formatTime, type Tone } from './format.js';

export interface RunnerView {
  name: string;
  label: string;
  tone: Tone;
  /** 0..1 or undefined when the runner reports no quota. */
  utilization: number | undefined;
  /** Full details for the tooltip / screen readers. */
  detail: string;
}

/** Availability in words (spec §8 cooldown / circuit breaker, §7 quota). */
export function describeRunner(r: RunnerStatus, now: number): RunnerView {
  const cooling = r.cooldown_until !== null && Date.parse(r.cooldown_until) > now;
  let label = '可用';
  let tone: Tone = 'ok';
  // the rate-limit loop guard stopped it: open until a person re-arms it (docs/adr/0022)
  if (r.halted_at) [label, tone] = ['已停用', 'bad'];
  else if (r.circuit === 'open') [label, tone] = ['熔斷', 'bad'];
  else if (r.quota?.exhausted) [label, tone] = ['額度用完', 'bad'];
  else if (cooling) [label, tone] = ['冷卻中', 'warn'];
  else if (!r.available) [label, tone] = ['不可用', 'bad'];
  else if (r.circuit === 'half_open') [label, tone] = ['試探中', 'warn'];

  const parts = [`${r.runner}：${label}`];
  const utilization = r.quota?.utilization ?? undefined;
  if (utilization !== undefined) parts.push(`額度已用 ${formatPercent(utilization)}`);
  if (r.quota?.resets_at) parts.push(`額度重置 ${formatTime(r.quota.resets_at)}`);
  if (cooling)
    parts.push(
      `冷卻到 ${formatTime(r.cooldown_until)}${r.cooldown_reason ? `（${r.cooldown_reason}）` : ''}`,
    );
  if (r.circuit_open_until && r.circuit !== 'closed')
    parts.push(`熔斷到 ${formatTime(r.circuit_open_until)}`);
  if (r.consecutive_failures > 0) parts.push(`連續失敗 ${r.consecutive_failures} 次`);
  if (r.halted_at) {
    parts.push(
      `冷卻後連續 ${r.rate_limit_loops} 次又撞到額度上限，停止自動恢復（回答待決事項以重新啟用）`,
    );
  }
  return { name: r.runner, label, tone, utilization, detail: parts.join('；') };
}

const ORDER = ['claude', 'codex', 'dsh'];

/** The three worker runners first (spec §13), then any other (e.g. `fake` in tests). */
export function sortRunners(runners: readonly RunnerStatus[]): RunnerStatus[] {
  const rank = (name: string) => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
  return [...runners].sort(
    (a, b) => rank(a.runner) - rank(b.runner) || a.runner.localeCompare(b.runner),
  );
}

export const LEADER_LABELS: Record<
  StateSnapshot['leader']['state'],
  { label: string; tone: Tone }
> = {
  idle: { label: '閒置', tone: 'ok' },
  busy: { label: '處理中', tone: 'info' },
  offline: { label: '離線', tone: 'neutral' },
};
