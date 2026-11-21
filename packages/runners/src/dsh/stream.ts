import type { RunResult, Usage } from '@agent-team/schema';
import { addUsage, classifyText, errorResult, str, usage } from '../classify.js';
import { lastLine, type StreamParser } from '../cli-driver.js';
import { extractReceiptObject, isPlainObject } from '../json.js';
import type { ChildResult } from '../process/spawn.js';

// Parser for `dsh --profile headless --json`: `session` (sessionId), `status` phases
// (`turn_start`, `step_start`, `step_end` with usage, `turn_end` with reason), `text`,
// `thinking`, `tool_call`, `tool_result`, the terminal `final` { text } (end signal), and `error`
// for failures outside a turn (then the stream ends without `final`).

export function dshUsage(u: unknown): Usage | undefined {
  if (!isPlainObject(u)) return undefined;
  return usage({
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_tokens: u.cacheReadTokens,
    cache_write_tokens: u.cacheWriteTokens,
    reasoning_tokens: u.reasoningTokens,
  });
}

/** `turn_end` reason kinds that mean the turn finished normally (dsh 0.2.1: `completed`). */
const SUCCESS_TURN_KINDS = new Set(['completed']);

interface TurnEnd {
  kind: string;
  code?: string;
  message?: string;
}

export class DshStream implements StreamParser {
  sessionRef: string | undefined;
  usage: Usage | undefined;
  turnEnd: TurnEnd | undefined;
  finalText: string | undefined;
  streamError: string | undefined;

  /** `session` is the first agent event. */
  started(event: Record<string, unknown> | undefined): { sessionRef?: string } | undefined {
    if (event?.type !== 'session') return undefined;
    return typeof event.sessionId === 'string' ? { sessionRef: event.sessionId } : {};
  }

  /** An `error` event before any session: dsh refused the invocation (e.g. unknown session). */
  refused(): boolean {
    return this.streamError !== undefined && this.sessionRef === undefined;
  }

  line(event: Record<string, unknown> | undefined): boolean {
    if (!event) return false;
    switch (event.type) {
      case 'session':
        if (typeof event.sessionId === 'string') this.sessionRef = event.sessionId;
        return false;
      case 'status':
        if (event.phase === 'step_end') this.usage = addUsage(this.usage, dshUsage(event.usage));
        if (event.phase === 'turn_end' && isPlainObject(event.reason)) {
          const reason = event.reason;
          const err = isPlainObject(reason.error) ? reason.error : {};
          const code = str(err.code);
          const message = str(err.message);
          this.turnEnd = {
            kind: str(reason.kind) ?? 'unknown',
            ...(code === undefined ? {} : { code }),
            ...(message === undefined ? {} : { message }),
          };
        }
        return false;
      case 'error':
        this.streamError = str(event.message) ?? 'dsh error';
        return false;
      case 'final':
        this.finalText = str(event.text) ?? '';
        return true;
      default:
        return false;
    }
  }

  partial(): Omit<RunResult, 'error' | 'final'> {
    return {
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.sessionRef ? { sessionRef: this.sessionRef } : {}),
    };
  }

  finish({ child, stderrTail }: { child: ChildResult; stderrTail: string[] }): RunResult {
    const base = this.partial();
    const te = this.turnEnd;
    if (te?.kind === 'error') {
      const message = `dsh ${te.code ?? 'error'}: ${te.message ?? 'turn failed'}`;
      const kind =
        te.code === 'MISSING_CREDENTIAL'
          ? 'auth'
          : classifyText(`${te.code ?? ''} ${te.message ?? ''}`);
      return errorResult(kind, message, base);
    }
    if (te?.kind === 'aborted') return errorResult('crash', 'dsh turn aborted', base);
    if (this.finalText !== undefined && !(te && SUCCESS_TURN_KINDS.has(te.kind))) {
      // `final` counts only after a turn that ended successfully (dsh's own success signal)
      return te
        ? errorResult('bad_output', `dsh turn ended with ${te.kind}; final not accepted`, base)
        : errorResult('crash', 'dsh sent final without a turn_end', base);
    }
    if (this.finalText === undefined) {
      const detail = this.streamError ?? lastLine(stderrTail);
      const text = `${this.streamError ?? ''}\n${stderrTail.join('\n')}`;
      const kind = /MISSING_CREDENTIAL/.test(text) ? 'auth' : classifyText(text);
      const how = child.signal ?? `code ${child.exitCode}`;
      return errorResult(kind, `dsh exited with ${how} without a final event: ${detail}`, base);
    }
    const final = extractReceiptObject(this.finalText);
    if (!final) {
      return errorResult('bad_output', 'dsh final text contains no JSON object', base);
    }
    return { ...base, final };
  }
}
