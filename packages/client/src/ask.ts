import type { MessageSource } from '@agent-team/schema';
import type { LeaderMessageDetail, LeaderReply, LeaderStatusView, TeamClient } from './client.js';
import { TeamApiError } from './errors.js';
import { randomId } from './ids.js';

// Talking to the leader from a terminal or an agent (`team ask`, MCP `ask_leader`). A leader turn
// may take up to 10 minutes; Node's fetch gives up on response headers after 300 s. So the POST
// waits at most `leader.reply_wait_ms` (server-side, 240 s) and then answers `pending: true`;
// from there this helper polls GET /api/leader/messages/{id} until the reply exists, the leader
// cannot answer, or the caller aborts (Ctrl-C, MCP cancellation).

export interface AskLeaderOptions {
  text: string;
  source: MessageSource;
  /** Dedupe key (default: a random id). Re-asking with the same id never duplicates the input. */
  clientMsgId?: string;
  /** Stop waiting (the message stays stored and queued; the reply still arrives later). */
  signal?: AbortSignal;
  /** Poll interval while the reply is pending (default 2000 ms). */
  pollMs?: number;
  /** Called once when the first answer was `pending` (e.g. print "still working…"). */
  onPending?: (info: { messageId: string; leader: LeaderStatusView }) => void;
}

export interface AskLeaderResult {
  reply: string;
  message_id: string;
  reply_message_id: string | null;
}

/** The waiting caller gave up (signal): the message is kept and answered later. */
export class AskAbortedError extends Error {
  override name = 'AskAbortedError';
  constructor(readonly messageId: string | undefined) {
    super('stopped waiting for the leader');
  }
}

/** Reasons a pending message will not be answered soon (stop polling and say why). */
const STUCK = new Set(['disabled', 'not_installed', 'auth', 'rate_limit']);

function unavailable(leader: LeaderStatusView, messageId: string): TeamApiError {
  const why = leader.reason ?? 'unavailable';
  return new TeamApiError(
    {
      code: 'unavailable',
      message: `the leader cannot answer right now (${why}); message ${messageId} is stored and queued`,
      hint:
        leader.hint ??
        'the reply appears in the board chat once the leader is back (GET /api/leader/messages)',
    },
    503,
  );
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The outcome of one poll: the answer, a reason to stop, or keep waiting. */
export function pollOutcome(
  detail: LeaderMessageDetail,
): { done: AskLeaderResult } | { fail: TeamApiError } | { wait: true } {
  const { message, reply, leader } = detail;
  if (reply) {
    return { done: { reply: reply.body, message_id: message.id, reply_message_id: reply.id } };
  }
  if (message.status !== 'new') {
    return {
      fail: new TeamApiError(
        {
          code: 'conflict',
          message: `the leader could not answer message ${message.id}`,
          hint: 'send it again (a new message)',
        },
        409,
      ),
    };
  }
  if (leader.available === false && leader.reason && STUCK.has(leader.reason)) {
    return { fail: unavailable(leader, message.id) };
  }
  return { wait: true };
}

/** Send `text` to the leader and resolve with its reply, however long the turn takes. */
export async function askLeader(
  client: TeamClient,
  options: AskLeaderOptions,
): Promise<AskLeaderResult> {
  const { signal } = options;
  const pollMs = options.pollMs ?? 2000;
  let messageId: string | undefined;
  try {
    const first: LeaderReply = await client.sendLeaderMessage(
      {
        text: options.text,
        source: options.source,
        client_msg_id: options.clientMsgId ?? randomId(),
        wait: true,
      },
      signal ? { signal } : {},
    );
    messageId = first.message_id;
    if (!first.pending && first.reply !== null) {
      return {
        reply: first.reply,
        message_id: first.message_id,
        reply_message_id: first.reply_message_id,
      };
    }
    options.onPending?.({ messageId, leader: first.leader });
    for (;;) {
      await sleep(pollMs, signal);
      if (signal?.aborted) throw new AskAbortedError(messageId);
      const outcome = pollOutcome(await client.leaderMessage(messageId, signal ? { signal } : {}));
      if ('done' in outcome) return outcome.done;
      if ('fail' in outcome) throw outcome.fail;
    }
  } catch (err) {
    if (signal?.aborted && !(err instanceof AskAbortedError)) throw new AskAbortedError(messageId);
    throw err;
  }
}
