import type { TaskStatus } from '@agent-team/schema';
import type { ReactNode } from 'react';
import { STATUS_LABELS, STATUS_TONES, type Tone } from '../../lib/format.js';

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-raised text-fg border-line',
  info: 'bg-info-soft text-info border-info/40',
  ok: 'bg-ok-soft text-ok border-ok/40',
  warn: 'bg-warn-soft text-warn border-warn/40',
  bad: 'bg-bad-soft text-bad border-bad/40',
};

export function Badge({
  tone = 'neutral',
  children,
  title,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-px text-xs leading-5 ${TONE_CLASSES[tone]} ${className ?? ''}`}
    >
      {children}
    </span>
  );
}

/** Shape + text, so status never depends on colour alone. */
const STATUS_ICONS: Record<TaskStatus, string> = {
  draft: '○',
  queued: '◷',
  running: '▶',
  verifying: '◐',
  review: '◆',
  done: '✓',
  blocked: '■',
  failed: '✕',
  cancelled: '⊘',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]}>
      <span aria-hidden="true">{STATUS_ICONS[status]}</span>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
