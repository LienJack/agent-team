/** `date + ms` as ISO UTC. */
export function addMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

/** Exponential backoff: initial, 2×, 4×, … capped at `max` (attempt is 1-based). */
export function backoffMs(attempt: number, initialMs: number, maxMs: number): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(maxMs, initialMs * 2 ** Math.min(exp, 30));
}

/** True when ISO timestamp `iso` is strictly after `now`. */
export function isAfter(iso: string | null | undefined, now: Date): boolean {
  return iso != null && Date.parse(iso) > now.getTime();
}

/** Last `n` lines of `text` (trailing newline ignored). */
export function lastLines(text: string, n: number): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.slice(-n).join('\n');
}
