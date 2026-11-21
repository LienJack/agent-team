import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Open dialogs, innermost last: only the top one reacts to Escape / Tab. */
const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** `sheet`: full-height panel from the right (full screen on phones); `center`: small modal. */
  variant?: 'sheet' | 'center';
  /** Extra content in the header row (e.g. status badge). */
  headerExtra?: ReactNode;
  footer?: ReactNode;
}

/**
 * Modal dialog: focus moves in on open and back on close, Tab stays inside, Escape and the
 * backdrop close it. Rendered only while open.
 */
export function Dialog({
  title,
  onClose,
  children,
  variant = 'center',
  headerExtra,
  footer,
}: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const me = Symbol('dialog');
    stack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1) !== me) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      stack.splice(stack.indexOf(me), 1);
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  const placement =
    variant === 'sheet'
      ? 'inset-y-0 right-0 w-full sm:max-w-2xl sm:border-l'
      : 'inset-x-3 top-[8vh] mx-auto max-h-[84vh] max-w-lg rounded-lg border';

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`absolute flex flex-col border-line bg-surface shadow-xl outline-none ${placement}`}
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold break-words">
            {title}
          </h2>
          {headerExtra}
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="-mr-1 rounded p-1 text-muted hover:bg-raised hover:text-fg"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
