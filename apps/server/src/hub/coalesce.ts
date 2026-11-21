import type { KvRepository } from '@agent-team/core';
import type { NotifyKind, OutboxItem, ServiceConfig } from '@agent-team/schema';

// Routine progress coalescing and quiet hours (spec §10 同類進度在時間窗內合併). The engine
// queues one outbox item per notification; for routine kinds the hub accepts the item into a
// durable buffer (kv) — the item is then `sent` to the hub — and later flushes each kind as ONE
// new outbox item (`digest:<kind>:<first id>`), so delivery still goes through outbox + effect.
// Attention items and quota notices never come here: they are sent at once, also in quiet hours.

export const BUFFER_KEY = 'hub:digest';

/** Kinds that are sent immediately, never merged and never held for quiet hours. */
export const IMMEDIATE_KINDS: ReadonlySet<NotifyKind> = new Set([
  'attention',
  'quota_exhausted',
  'reply',
]);

export interface Buffered {
  id: string;
  kind: NotifyKind;
  body: string;
  task_id: string | null;
  /** When the hub accepted it (ISO). */
  at: string;
}

const LABEL: Partial<Record<NotifyKind, string>> = {
  task_done: '任務完成',
  task_failed: '任務失敗',
  task_blocked: '任務阻塞',
  no_receipt: 'worker 無回執',
  circuit_open: 'runner 熔斷',
};

const MAX_DIGEST_CHARS = 1500;

export function readBuffer(kv: KvRepository): Buffered[] {
  try {
    const parsed: unknown = JSON.parse(kv.get(BUFFER_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as Buffered[]) : [];
  } catch {
    return [];
  }
}

export function writeBuffer(kv: KvRepository, items: readonly Buffered[]): void {
  kv.set(BUFFER_KEY, JSON.stringify(items));
}

/** Add `item` (idempotent: an effect retried after a crash adds nothing twice). */
export function bufferItem(kv: KvRepository, item: OutboxItem, at: string): void {
  const items = readBuffer(kv);
  if (items.some((b) => b.id === item.id)) return;
  items.push({ id: item.id, kind: item.kind, body: item.body, task_id: item.task_id, at });
  writeBuffer(kv, items);
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `now` (local time) is inside the quiet hours; end is exclusive, may wrap midnight. */
export function inQuietHours(now: Date, quiet: ServiceConfig['grok']['quiet_hours']): boolean {
  if (!quiet) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** The next local time `quiet.end` after `now` (ms epoch). */
export function quietEnd(
  now: Date,
  quiet: NonNullable<ServiceConfig['grok']['quiet_hours']>,
): number {
  const end = new Date(now);
  end.setHours(Number(quiet.end.slice(0, 2)), Number(quiet.end.slice(3, 5)), 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime();
}

export interface DueGroup {
  kind: NotifyKind;
  items: Buffered[];
}

/**
 * Groups (one per kind) whose window has passed at `now`, and when the next group is due
 * (ms epoch; undefined when the buffer is empty). Nothing is due during quiet hours.
 */
export function dueGroups(
  items: readonly Buffered[],
  now: Date,
  grok: Pick<ServiceConfig['grok'], 'coalesce_window_ms' | 'quiet_hours'>,
): { due: DueGroup[]; nextAt: number | undefined } {
  const byKind = new Map<NotifyKind, Buffered[]>();
  for (const item of items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  const quiet = inQuietHours(now, grok.quiet_hours);
  const due: DueGroup[] = [];
  let nextAt: number | undefined;
  for (const [kind, group] of byKind) {
    const at = Date.parse(group[0]!.at) + grok.coalesce_window_ms;
    const ready = quiet && grok.quiet_hours ? Math.max(at, quietEnd(now, grok.quiet_hours)) : at;
    if (!quiet && at <= now.getTime()) due.push({ kind, items: group });
    else nextAt = Math.min(nextAt ?? ready, ready);
  }
  return { due, nextAt };
}

/** One message for a group: the single body as is, or a counted list. */
export function digestBody(group: DueGroup): string {
  if (group.items.length === 1) return group.items[0]!.body;
  const header = `${LABEL[group.kind] ?? group.kind}（${group.items.length} 則）`;
  const lines: string[] = [];
  let length = header.length;
  for (const [i, item] of group.items.entries()) {
    const line = `- ${item.body.replace(/\s+/g, ' ').trim()}`;
    if (length + line.length + 1 > MAX_DIGEST_CHARS) {
      lines.push(`- …另有 ${group.items.length - i} 則`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return [header, ...lines].join('\n');
}
