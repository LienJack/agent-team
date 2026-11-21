import type { KvRepository } from '@agent-team/core';
import type { LeaderStatus, LeaderUnavailableReason } from '@agent-team/schema';
import { LEADER_CONVERSATION_KEY, LEADER_SESSION_KEY } from './types.js';

// Durable state of the one leader conversation (kv). Nothing about tasks lives here: after a
// compaction or a new session the leader is re-briefed from the database (resumeBrief).

export interface Unavailable {
  reason: Extract<LeaderUnavailableReason, 'auth' | 'rate_limit'>;
  /** Rate limit: retry at this time. */
  until: string | null;
  hint: string;
}

export interface ConversationState {
  session_id: string;
  /** The CLI has created the session (later turns use `--resume`). */
  started: boolean;
  prompt_version: string;
  /** Context size after the last turn. */
  context_tokens: number | null;
  /** Prepend the resume brief to the next turn (new session, after compaction). */
  needs_brief: boolean;
  /** Run `/compact` before the next input. */
  needs_compact: boolean;
  unavailable: Unavailable | null;
  quota: NonNullable<LeaderStatus['quota']> | null;
}

export function freshConversation(
  sessionId: string,
  promptVersion: string,
  keep: Pick<ConversationState, 'quota'> = { quota: null },
): ConversationState {
  return {
    session_id: sessionId,
    started: false,
    prompt_version: promptVersion,
    context_tokens: null,
    needs_brief: true,
    needs_compact: false,
    unavailable: null,
    quota: keep.quota,
  };
}

/** Load the stored state; a missing, unreadable or outdated (prompt version) one starts fresh. */
export function loadConversation(
  kv: KvRepository,
  promptVersion: string,
  newSessionId: () => string,
): { state: ConversationState; fresh: boolean } {
  const sessionId = kv.get(LEADER_SESSION_KEY);
  let stored: Partial<ConversationState> | undefined;
  try {
    const raw = kv.get(LEADER_CONVERSATION_KEY);
    stored = raw === undefined ? undefined : (JSON.parse(raw) as Partial<ConversationState>);
  } catch {
    stored = undefined;
  }
  if (sessionId === undefined || stored === undefined || stored.prompt_version !== promptVersion) {
    return {
      state: freshConversation(newSessionId(), promptVersion, { quota: stored?.quota ?? null }),
      fresh: true,
    };
  }
  return {
    state: {
      ...freshConversation(sessionId, promptVersion),
      ...stored,
      session_id: sessionId,
    },
    fresh: false,
  };
}

export function saveConversation(kv: KvRepository, state: ConversationState): void {
  kv.set(LEADER_SESSION_KEY, state.session_id);
  const { session_id: _id, ...rest } = state;
  kv.set(LEADER_CONVERSATION_KEY, JSON.stringify(rest));
}
