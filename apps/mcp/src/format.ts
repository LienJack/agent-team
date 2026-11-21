import type { Attention, StateSnapshot, Task } from '@agent-team/client';
import { BOARD_COLUMNS } from '@agent-team/schema';

// Short plain-text renderings. Deliberately no ticket bodies, receipts, logs or transcripts:
// a calling model must never need to read worker output (spec §12).

const MAX_ITEMS = 12;

export function clip(text: string, max = 100): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function taskLine(t: Task): string {
  return `${t.id} [${t.status}] ${t.tier} ${t.impl_role} ${clip(t.title, 70)}`;
}

export function attentionLine(a: Attention): string {
  const options =
    a.options.length > 0 ? ` options: ${a.options.map((o) => clip(o, 60)).join(' | ')}` : '';
  const task = a.task_id ? ` task ${a.task_id}` : '';
  return `${a.id} [${a.kind}]${task} ${clip(a.question, 160)}${options}`;
}

export function attentionList(items: readonly Attention[]): string {
  if (items.length === 0) return 'no open attention items';
  const shown = items.slice(0, MAX_ITEMS).map(attentionLine);
  if (items.length > MAX_ITEMS) shown.push(`… and ${items.length - MAX_ITEMS} more`);
  return shown.join('\n');
}

/** Compact board summary, well under 40 lines. */
export function formatStatus(s: StateSnapshot): string {
  const visible = s.tasks.filter((t) => t.status !== 'cancelled');
  const columns = BOARD_COLUMNS.map((col) => {
    const n = visible.filter((t) => (col.statuses as readonly string[]).includes(t.status)).length;
    return `${col.id} ${n}`;
  });
  const lines = [`board: ${columns.join(' · ')}`];

  const runs = new Map(s.active_runs.map((r) => [r.task_id, r]));
  const active = visible.filter((t) => t.status === 'running' || t.status === 'verifying');
  if (active.length > 0) lines.push('running:');
  for (const t of active.slice(0, MAX_ITEMS)) {
    const run = runs.get(t.id);
    const who = run ? ` ← ${run.runner}/${run.model_alias} (${run.kind})` : '';
    lines.push(`  ${taskLine(t)}${who}`);
  }
  if (active.length > MAX_ITEMS) lines.push(`  … and ${active.length - MAX_ITEMS} more`);

  lines.push(
    `attention: ${s.open_attention.length} open${s.open_attention.length > 0 ? ' (use list_attention)' : ''}`,
  );
  const runners = s.runners.map((r) => {
    if (!r.available) {
      const why =
        r.circuit !== 'closed'
          ? `circuit ${r.circuit}`
          : r.cooldown_until
            ? `cooldown until ${r.cooldown_until}`
            : 'unavailable';
      return `${r.runner} ${why}`;
    }
    const used = r.quota?.utilization;
    const quota = r.quota?.exhausted
      ? ' quota exhausted'
      : used === null || used === undefined
        ? ''
        : ` quota ${Math.round(used * 100)}%`;
    return `${r.runner} ok${quota}`;
  });
  lines.push(`runners: ${runners.join(' · ') || 'none'}`);
  lines.push(`leader: ${s.leader.state}`);
  return lines.join('\n');
}
