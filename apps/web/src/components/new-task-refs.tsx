import type { BoardTask } from '@agent-team/client';
import { MAX_RESEARCH_REFS } from '@agent-team/schema';
import { toggleRef } from '../lib/new-task.js';

// The labels here stay clear of the words the e2e smoke looks fields up by (Playwright's
// getByLabel matches substrings): no 專案、標題 or owned_paths.

/**
 * 參考調研 (spec §17): done research tasks of the picked project an impl task may cite. At most
 * `MAX_RESEARCH_REFS`; once that many are checked the others are disabled.
 */
export function ResearchRefsPicker({
  options,
  value,
  onChange,
  error,
}: {
  options: readonly BoardTask[];
  value: readonly string[];
  onChange: (refs: string[]) => void;
  error: string | undefined;
}) {
  const full = value.length >= MAX_RESEARCH_REFS;
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">參考調研（最多 {MAX_RESEARCH_REFS} 個）</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted">還沒有已完成的調研可以參考。</p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-2">
          {options.map((t) => {
            const checked = value.includes(t.id);
            return (
              <li key={t.id}>
                <label
                  className={`flex min-w-0 items-center gap-2 text-sm ${!checked && full ? 'text-muted' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && full}
                    onChange={(e) => onChange(toggleRef(value, t.id, e.target.checked))}
                  />
                  <span className="min-w-0 truncate" title={t.title}>
                    {t.title}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted">{t.id}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted">
        勾選的調研回執會附在實作、修正與審查的提示裡，當參考資料而不是指令。
      </p>
      {error ? <p className="text-xs text-bad">{error}</p> : null}
    </fieldset>
  );
}
