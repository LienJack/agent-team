import type { RunErrorKind, RunQuota, RunResult, Usage } from '@agent-team/schema';

// Shared helpers turning CLI text into RunResult fields.

const AUTH_RE =
  /not logged in|please run \/login|\blogin\b.*(required|expired)|unauthori[sz]ed|\b401\b|invalid (api|x-api)[ -]?key|authentication|missing[_ ]credential|no credential|oauth token|token (has )?expired/i;
const RATE_RE =
  /rate[ _-]?limit|usage limit|hit your (usage )?limit|limit (has been )?reached|too many requests|\b429\b|quota (exceeded|exhausted)|weekly limit|5-hour limit/i;

/** `auth` / `rate_limit` when the text says so, otherwise `fallback`. */
export function classifyText(text: string, fallback: RunErrorKind = 'crash'): RunErrorKind {
  if (RATE_RE.test(text)) return 'rate_limit';
  if (AUTH_RE.test(text)) return 'auth';
  return fallback;
}

const MAX_MESSAGE = 2000;

export function errorResult(
  kind: RunErrorKind,
  message: string,
  partial: Omit<RunResult, 'error' | 'final'> = {},
): RunResult {
  return { ...partial, error: { kind, message: message.slice(0, MAX_MESSAGE) } };
}

/** Clamp/convert to the RunQuota shape (utilization 0..1, ISO `resetsAt`). */
export function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // epoch seconds (CLI events) or milliseconds
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+$/.test(value.trim())) return toIso(Number(value.trim()));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

export function clampUtilization(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

export function quota(fields: {
  utilization?: number | undefined;
  resetsAt?: string | undefined;
  exhausted?: boolean | undefined;
}): RunQuota | undefined {
  const q: RunQuota = {
    ...(fields.utilization === undefined ? {} : { utilization: fields.utilization }),
    ...(fields.resetsAt === undefined ? {} : { resetsAt: fields.resetsAt }),
    ...(fields.exhausted === undefined ? {} : { exhausted: fields.exhausted }),
  };
  return Object.keys(q).length > 0 ? q : undefined;
}

/**
 * Reset time from a limit message: a trailing `|<epoch>` (Claude), "try again in 2 hours 13
 * minutes" or "resets in 45 minutes" (relative to `now`).
 */
export function resetFromMessage(message: string, now = Date.now()): string | undefined {
  const epoch = /\|(\d{10,13})\b/.exec(message);
  if (epoch) return toIso(Number(epoch[1]));
  const rel = /(?:try again|resets?|available again) in ([^.]+)/i.exec(message);
  if (!rel) return undefined;
  let ms = 0;
  for (const m of rel[1]!.matchAll(/(\d+)\s*(day|hour|hr|minute|min|second|sec)s?/gi)) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    ms +=
      n *
      (unit.startsWith('d')
        ? 86_400_000
        : unit.startsWith('h')
          ? 3_600_000
          : unit.startsWith('m')
            ? 60_000
            : 1000);
  }
  return ms > 0 ? new Date(now + ms).toISOString() : undefined;
}

function nonNegInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Build a Usage from named counters, dropping unknown ones. */
export function usage(fields: Record<keyof Usage, unknown>): Usage | undefined {
  const out: Usage = {};
  for (const [key, value] of Object.entries(fields) as Array<[keyof Usage, unknown]>) {
    const n = nonNegInt(value);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Usage = { ...a };
  for (const [key, value] of Object.entries(b) as Array<[keyof Usage, number]>) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

export function nonNegNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
