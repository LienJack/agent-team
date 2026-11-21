import { useUi, type Toast } from '../../store/ui.js';

const TONES: Record<Toast['tone'], string> = {
  info: 'border-line bg-surface text-fg',
  ok: 'border-ok/50 bg-ok-soft text-ok',
  bad: 'border-bad/50 bg-bad-soft text-bad',
};

const ICONS: Record<Toast['tone'], string> = { info: 'ℹ', ok: '✓', bad: '!' };

/** Transient messages (drop explanations, action results); announced politely. */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col items-center gap-2 sm:left-auto sm:items-end"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'bad' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-md ${TONES[t.tone]}`}
        >
          <span aria-hidden="true" className="font-bold">
            {ICONS[t.tone]}
          </span>
          <p className="min-w-0 flex-1 break-words">{t.text}</p>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="關閉通知"
            className="rounded px-1 opacity-70 hover:opacity-100"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
