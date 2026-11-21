import type { RunResult, Usage } from '@agent-team/schema';
import {
  addUsage,
  classifyText,
  errorResult,
  quota,
  resetFromMessage,
  str,
  usage,
} from '../classify.js';
import { extractFirstJsonObject, isPlainObject } from '../json.js';

// Maps Codex SDK `runStreamed` events (codex exec --experimental-json) to a RunResult:
// `thread.started` (thread id = sessionRef), `item.completed` with `agent_message` (the last one
// is the final answer), `turn.completed.usage`, `turn.failed` / `error` (failures).

export function codexUsage(u: unknown): Usage | undefined {
  if (!isPlainObject(u)) return undefined;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const cached = typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined;
  return usage({
    // codex reports cached tokens as part of input_tokens; keep them separate like claude does
    input_tokens: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
    output_tokens: u.output_tokens,
    cache_read_tokens: cached,
    cache_write_tokens: u.cache_write_input_tokens,
    reasoning_tokens: u.reasoning_output_tokens,
  });
}

export class CodexStream {
  sessionRef: string | undefined;
  usage: Usage | undefined;
  lastMessage: string | undefined;
  failure: string | undefined;
  completed = false;

  /** Returns the thread id when this event announced it. */
  event(ev: unknown): string | undefined {
    if (!isPlainObject(ev)) return undefined;
    switch (ev.type) {
      case 'thread.started':
        if (typeof ev.thread_id === 'string') {
          this.sessionRef = ev.thread_id;
          return ev.thread_id;
        }
        return undefined;
      case 'item.completed': {
        const item = ev.item;
        if (isPlainObject(item) && item.type === 'agent_message' && typeof item.text === 'string') {
          this.lastMessage = item.text;
        }
        return undefined;
      }
      case 'turn.completed':
        this.completed = true;
        this.usage = addUsage(this.usage, codexUsage(ev.usage));
        return undefined;
      case 'turn.failed':
        this.failure = isPlainObject(ev.error)
          ? (str(ev.error.message) ?? 'turn failed')
          : 'turn failed';
        return undefined;
      case 'error':
        this.failure = str(ev.message) ?? 'codex stream error';
        return undefined;
      default:
        return undefined;
    }
  }

  partial(): Omit<RunResult, 'error' | 'final'> {
    return {
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.sessionRef ? { sessionRef: this.sessionRef } : {}),
    };
  }

  /** Error result for a failure message (turn.failed, error event or a thrown SDK error). */
  failed(message: string): RunResult {
    const kind = classifyText(message);
    const result = errorResult(kind, `codex: ${message}`, this.partial());
    if (kind !== 'rate_limit') return result;
    const q = quota({ utilization: 1, resetsAt: resetFromMessage(message), exhausted: true });
    return q ? { ...result, quota: q } : result;
  }

  /** Result after the event stream ended without an exception. */
  finish(): RunResult {
    if (this.failure && !this.completed) return this.failed(this.failure);
    if (this.lastMessage === undefined) {
      return errorResult('bad_output', 'codex ended without an agent message', this.partial());
    }
    const final = extractFirstJsonObject(this.lastMessage);
    if (!final)
      return errorResult('bad_output', 'codex final message is not a JSON object', this.partial());
    return { ...this.partial(), final };
  }
}
