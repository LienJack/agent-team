import type { RunnerHealth } from '@agent-team/schema';

// How long to wait for a reported quota reset (spec §8 錯誤, docs/adr/0022 §2). Pure: shared by
// the runner cooldown, the exhausted-quota check and the leader's own rate limit (apps/server).

/** A reset reported further ahead than this is implausible: treated as unknown. */
export const QUOTA_RESET_MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
/** Waited past the reported reset, so the first try does not land just before it. */
export const QUOTA_RESET_BUFFER_MS = 60_000;
/** Upper bound of the per-runner spread added on top (so runners do not retry in lockstep). */
export const QUOTA_RESET_JITTER_MAX_MS = 30_000;

/** FNV-1a (32 bit): a stable spread without randomness (core has no `Math.random`). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 0 … `QUOTA_RESET_JITTER_MAX_MS`, derived from `key` (runner name) and the reset time. */
export function quotaJitterMs(key: string, resetsAt: string): number {
  return fnv1a(`${key}|${resetsAt}`) % (QUOTA_RESET_JITTER_MAX_MS + 1);
}

/**
 * When to try again after a quota reset reported at `recordedAt`: `resetsAt` + buffer + jitter,
 * or undefined when the reset is unknown — missing, unparseable, not after `recordedAt` (already
 * past when it was reported) or more than 8 days after it. Callers fall back to their default
 * cooldown (15 minutes) for unknown resets; an exhausted quota with an unknown reset does not
 * hold the runner by itself (its next rate limit cools it down).
 */
export function quotaWaitUntil(
  resetsAt: string | null | undefined,
  recordedAt: Date,
  key: string,
): string | undefined {
  if (resetsAt === null || resetsAt === undefined) return undefined;
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset)) return undefined;
  const ahead = reset - recordedAt.getTime();
  if (ahead <= 0 || ahead > QUOTA_RESET_MAX_AHEAD_MS) return undefined;
  return new Date(reset + QUOTA_RESET_BUFFER_MS + quotaJitterMs(key, resetsAt)).toISOString();
}

/**
 * Until when an exhausted quota holds the runner: its reported reset plus buffer and jitter,
 * capped like a cooldown (a reset more than 8 days after the report is unknown → not held).
 */
export function exhaustedUntil(health: Pick<RunnerHealth, 'runner' | 'quota'>): string | undefined {
  const q = health.quota;
  if (!q?.exhausted) return undefined;
  return quotaWaitUntil(q.resets_at, new Date(q.updated_at), health.runner);
}
