import type {
  Attention,
  DoctorReport,
  Project,
  RoleInfo,
  Run,
  StateSnapshot,
  Task,
  TaskDetail,
} from '@agent-team/client';
import { BOARD_COLUMNS, type EventRecord } from '@agent-team/schema';

// Short plain-text output (spec §12). One line per item; `--json` bypasses all of this.

function clip(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function projectLine(p: Project): string {
  const checks = p.checks.length === 1 ? '1 check' : `${p.checks.length} checks`;
  return `${p.id} ${p.name} ${p.repo_path} (${p.base_branch}, ${checks})`;
}

export function taskLine(t: Task): string {
  return `${t.id} [${t.status}] ${t.tier} ${t.impl_role} ${clip(t.title, 70)}`;
}

export function runLine(r: Run): string {
  const outcome = r.outcome ? ` ${r.outcome}` : '';
  const reason = r.reject_reason ? ` (${clip(r.reject_reason, 60)})` : '';
  return `${r.id} ${r.kind} ${r.role} ${r.model_alias} ${r.state}${outcome}${reason}`;
}

export function attentionLine(a: Attention): string {
  const options = a.options.length > 0 ? ` [${a.options.join(' / ')}]` : '';
  const task = a.task_id ? ` task ${a.task_id}` : '';
  const answer = a.status === 'answered' ? ` → ${clip(a.answer ?? '', 40)}` : '';
  return `${a.id} [${a.kind}/${a.status}]${task} ${clip(a.question)}${options}${answer}`;
}

type RunnerQuota = StateSnapshot['runners'][number]['quota'];

/** ` (34% used, resets 2026-11-26T18:00Z)` — the last quota a runner reported, if any. */
export function quotaText(q: RunnerQuota): string {
  if (!q) return '';
  const parts: string[] = [];
  if (q.exhausted) parts.push('exhausted');
  else if (q.utilization !== null && q.utilization !== undefined) {
    parts.push(`${Math.round(q.utilization * 100)}% used`);
  }
  if (q.resets_at) parts.push(`resets ${q.resets_at.replace(/:\d\d\.\d{3}Z$/, 'Z')}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

export function formatStatus(s: StateSnapshot): string {
  const visible = s.tasks.filter((t) => t.status !== 'cancelled');
  const columns = BOARD_COLUMNS.map((col) => {
    const n = visible.filter((t) => (col.statuses as readonly string[]).includes(t.status)).length;
    return `${col.id} ${n}`;
  });
  const lines = [`tasks: ${columns.join(' · ')}`];
  const active = visible.filter((t) => ['running', 'verifying', 'review'].includes(t.status));
  for (const t of active) lines.push(`  ${taskLine(t)}`);
  lines.push(`attention: ${s.open_attention.length} open`);
  const runners = s.runners.map((r) => {
    if (!r.available) {
      const why =
        r.circuit !== 'closed'
          ? `circuit ${r.circuit}`
          : r.cooldown_until
            ? `cooldown until ${r.cooldown_until}`
            : 'unavailable';
      return `${r.runner} ${why}${quotaText(r.quota)}`;
    }
    return `${r.runner} ok${quotaText(r.quota)}`;
  });
  lines.push(`runners: ${runners.join(' · ') || 'none'}`);
  const why = s.leader.reason
    ? ` (${s.leader.reason}${s.leader.until ? ` until ${s.leader.until}` : ''})`
    : '';
  lines.push(`leader: ${s.leader.state}${why}`);
  return lines.join('\n');
}

export function formatTaskDetail(d: TaskDetail): string {
  const t = d.task;
  const lines = [
    taskLine(t),
    `  project ${t.project_id} · priority ${t.priority} · fix_rounds ${t.fix_rounds} · attempts ${t.attempts}`,
    `  paths ${t.owned_paths.join(', ')}`,
  ];
  if (t.blocked_reason) lines.push(`  blocked: ${clip(t.blocked_reason, 100)}`);
  if (d.workspace) {
    lines.push(
      `  workspace ${d.workspace.path} (${d.workspace.branch}, head ${d.workspace.head_sha ?? '-'})`,
    );
  }
  for (const r of d.runs) lines.push(`  run ${runLine(r)}`);
  for (const a of d.attention) lines.push(`  attention ${attentionLine(a)}`);
  return lines.join('\n');
}

/** The latest receipt of a task's runs, formatted; undefined when there is none. */
export function formatReceipt(d: TaskDetail): string | undefined {
  const run = [...d.runs].reverse().find((r) => r.receipt !== null);
  if (!run || !run.receipt) return undefined;
  const receipt = run.receipt;
  const head = `${run.id} ${run.kind} ${run.role} ${run.model_alias}`;
  if ('verdict' in receipt) {
    const lines = [`${head}: ${receipt.verdict}`, `  ${clip(receipt.summary, 600)}`];
    for (const f of receipt.findings) {
      lines.push(
        `  ${f.severity} ${f.file}${f.line > 0 ? `:${f.line}` : ''} ${clip(f.issue, 100)}`,
      );
    }
    return lines.join('\n');
  }
  const lines = [`${head}: ${receipt.status}`, `  ${clip(receipt.summary, 600)}`];
  if (receipt.files_changed.length > 0) lines.push(`  files ${receipt.files_changed.join(', ')}`);
  for (const c of receipt.checks)
    lines.push(`  check ${c.result} ${c.cmd}${c.note ? ` (${clip(c.note, 60)})` : ''}`);
  if (receipt.needs_leader) lines.push(`  needs leader: ${clip(receipt.needs_leader, 200)}`);
  return lines.join('\n');
}

export function formatDoctor(d: DoctorReport): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL');
  const lines = d.checks.map((c) => `${mark(c.ok)} ${c.name} ${c.detail}`);
  for (const r of d.runners) {
    const version = r.version ? ` ${r.version}` : '';
    const problems = r.problems.length > 0 ? `: ${r.problems.join('; ')}` : '';
    lines.push(
      `${mark(r.available)} runner ${r.runner}${version} (credentials ${r.credentials})${problems}`,
    );
  }
  lines.push(d.ok ? 'doctor: ok' : 'doctor: problems found');
  return lines.join('\n');
}

/** One line per event for `team watch`. */
export function eventLine(e: EventRecord): string {
  const refs = [e.task_id, e.run_id].filter((x) => x !== null).join(' ');
  let detail: string;
  if (e.type === 'task.status_changed') {
    detail = `${e.data.from}→${e.data.to}${e.data.reason ? ` (${clip(e.data.reason, 60)})` : ''}`;
  } else if (e.type === 'run.state_changed') {
    detail = `${e.data.from}→${e.data.to}`;
  } else {
    detail = clip(JSON.stringify(e.data), 100);
  }
  return `#${e.seq} ${e.ts} ${e.type}${refs ? ` ${refs}` : ''} ${detail}`;
}

/** `impl_B  gpt-sol (codex) ×3  → kimi-pro, sonnet  多檔案、需要判斷或除錯` */
export function roleLine(r: RoleInfo): string {
  const fallback = r.fallback.length > 0 ? `  → ${r.fallback.join(', ')}` : '';
  const off = r.enabled ? '' : '  [disabled]';
  const desc = r.description ? `  ${clip(r.description, 40)}` : '';
  return `${r.name}  ${r.model_alias} (${r.runner}) ×${r.slots}${fallback}${off}${desc}`;
}
