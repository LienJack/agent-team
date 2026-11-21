import { TeamError, type Tx } from '@agent-team/core';
import type { LeaderStatus } from '@agent-team/schema';
import type { ConversationState } from './conversation.js';

// What the leader reports about itself (GET /api/state `leader`, the `leader.status_changed`
// event): idle / busy / offline, availability with reason, hint and retry time.

export type Offline = { reason: 'disabled' | 'not_installed'; hint: string };

export interface StatusInputs {
  offline: Offline | undefined;
  started: boolean;
  conv: Pick<ConversationState, 'unavailable' | 'context_tokens' | 'quota'>;
  running: boolean;
  queued: number;
  lastActivity: string | null;
}

export type Why = { reason: LeaderStatus['reason']; hint: string; until: string | null };

/** Why turns cannot run right now; undefined = available. */
export function whyUnavailable(i: StatusInputs): Why | undefined {
  if (i.offline) return { reason: i.offline.reason, hint: i.offline.hint, until: null };
  if (!i.started) return { reason: null, hint: 'the leader is starting', until: null };
  const u = i.conv.unavailable;
  return u ? { reason: u.reason, hint: u.hint, until: u.until } : undefined;
}

export function leaderStatus(i: StatusInputs): LeaderStatus {
  const why = whyUnavailable(i);
  return {
    state: why ? 'offline' : i.running ? 'busy' : 'idle',
    last_activity_at: i.lastActivity,
    available: why === undefined,
    reason: why?.reason ?? null,
    hint: why?.hint ?? null,
    until: why?.until ?? null,
    queued: i.queued,
    context_tokens: i.conv.context_tokens,
    quota: i.conv.quota,
  };
}

export function unavailableError(why: Why | undefined): TeamError {
  return new TeamError(
    'unavailable',
    `the leader cannot answer right now (${why?.reason ?? 'unavailable'}); the message is stored and queued`,
    why?.hint ?? 'try again later; GET /api/leader/messages shows the reply once it exists',
  );
}

/**
 * Emits `leader.status_changed` (durable, so the board's top bar updates live) whenever the
 * reported state, availability, reason or retry time differs from the last one emitted.
 */
export class StatusEvents {
  private last: string | undefined;

  private static key(s: LeaderStatus): string {
    return `${s.state}|${s.available}|${s.reason ?? ''}|${s.until ?? ''}`;
  }

  /** Remember `status` as already known (no event), e.g. right after startup. */
  baseline(status: LeaderStatus): void {
    this.last = StatusEvents.key(status);
  }

  /** True when `status` differs from the last emitted one. */
  changed(status: LeaderStatus): boolean {
    return StatusEvents.key(status) !== this.last;
  }

  emit(tx: Tx, status: LeaderStatus): void {
    this.last = StatusEvents.key(status);
    tx.emit('leader.status_changed', {
      state: status.state,
      available: status.available ?? true,
      reason: status.reason ?? null,
      until: status.until ?? null,
    });
  }
}
