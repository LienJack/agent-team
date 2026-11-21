import { useEffect } from 'react';
import { useUi, type ThemeChoice } from '../store/ui.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Keeps `<html data-theme>` in sync with the choice and, for "system", the OS setting. */
export function useApplyTheme(): void {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media?.matches === true);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system' || !media) return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const LABELS: Record<ThemeChoice, string> = { system: '跟隨系統', light: '淺色', dark: '深色' };
const ICONS: Record<ThemeChoice, string> = { system: '◑', light: '☀', dark: '☾' };

export function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT[theme])}
      aria-label={`主題：${LABELS[theme]}（按一下切換為${LABELS[NEXT[theme]]}）`}
      title={`主題：${LABELS[theme]}`}
      className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-2 text-xs hover:bg-raised"
    >
      <span aria-hidden="true">{ICONS[theme]}</span>
      <span className="hidden sm:inline">{LABELS[theme]}</span>
    </button>
  );
}
