import type { RunErrorKind, RunQuota, RunResult } from '@agent-team/schema';
import {
  clampUtilization,
  classifyText,
  errorResult,
  nonNegNumber,
  quota,
  resetFromMessage,
  str,
  toIso,
  usage,
} from '../classify.js';
import { lastLine, type StreamParser } from '../cli-driver.js';
import { extractReceiptObject, isPlainObject } from '../json.js';
import type { ChildResult } from '../process/spawn.js';

// Parser for `claude -p --output-format stream-json --verbose`: `system/init` (session id),
// `rate_limit_event` (subscription quota), assistant/user turns, and the final `result`
// (end signal: usage, cost, is_error, structured_output).

/**
 * Quota from a `rate_limit_event.rate_limit_info`. Claude Code 2.1.326 sends
 * `{ status, resetsAt, rateLimitType, unifiedWindows: { seven_day: { utilization, resetsAt,
 * status } } }` (recorded in the smoke run); older builds send only the flat fields. The busiest
 * window wins; a rejected window (or top-level status) means exhausted.
 */
export function parseClaudeRateLimit(info: unknown): RunQuota | undefined {
  if (!isPlainObject(info)) return undefined;
  const status = str(info.status);
  const windows: Array<{ utilization?: number; resetsAt?: string; rejected: boolean }> = [];
  const pushWindow = (w: Record<string, unknown>) => {
    const u = clampUtilization(w.utilization);
    const r = toIso(w.resetsAt ?? w.resets_at);
    const ws = str(w.status);
    windows.push({
      ...(u === undefined ? {} : { utilization: u }),
      ...(r === undefined ? {} : { resetsAt: r }),
      rejected: ws !== undefined && !ws.startsWith('allowed'),
    });
  };
  const unified = info.unifiedWindows ?? info.unified_windows;
  if (isPlainObject(unified)) {
    for (const w of Object.values(unified)) if (isPlainObject(w)) pushWindow(w);
  }
  if (windows.length === 0) pushWindow(info);
  const blocked = windows.filter((w) => w.rejected);
  let busiest = blocked[0] ?? windows[0];
  for (const w of blocked.length > 0 ? blocked : windows) {
    if ((w.utilization ?? -1) > (busiest?.utilization ?? -1)) busiest = w;
  }
  const rejected = (status !== undefined && !status.startsWith('allowed')) || blocked.length > 0;
  const utilization = busiest?.utilization;
  return quota({
    utilization: rejected ? 1 : utilization,
    resetsAt: busiest?.resetsAt,
    exhausted: rejected || (utilization !== undefined && utilization >= 1),
  });
}

export function claudeUsage(u: unknown): RunResult['usage'] {
  if (!isPlainObject(u)) return undefined;
  return usage({
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_tokens: u.cache_read_input_tokens,
    cache_write_tokens: u.cache_creation_input_tokens,
    reasoning_tokens: undefined,
  });
}

/** `SDKAssistantMessageError` values (the `error` field of an assistant event). */
const ASSISTANT_RATE_ERRORS = new Set(['rate_limit']);
const ASSISTANT_AUTH_ERRORS = new Set(['authentication_failed', 'billing_error']);

/**
 * Where a failed claude run's error kind may come from: structured fields only — the `error`
 * field of an assistant event (Claude Code writes a synthetic assistant message for an API
 * failure), the result's `api_error_status`, an exhausted `rate_limit_event` — plus Claude
 * Code's own text: stderr, and the result text/errors only while the model has not written a
 * single message (then the text is the CLI's, e.g. "Not logged in"). Model-authored text never
 * decides: a worker printing "usage limit reached" must not cool the runner down or get its
 * attempt refunded.
 */
export class ClaudeErrorSignals {
  /** A (non-synthetic) assistant message was seen: result text may be the model's. */
  modelSpoke = false;
  /** The last assistant `error` field. */
  apiError: string | undefined;

  observe(event: Record<string, unknown> | undefined): void {
    if (event?.type !== 'assistant') return;
    const error = str(event.error);
    if (error !== undefined) this.apiError = error;
    const model = isPlainObject(event.message) ? str(event.message.model) : undefined;
    if (error === undefined && model !== '<synthetic>') this.modelSpoke = true;
  }

  /** The error kind of a failed run (`result` = the result event, if there was one). */
  kind(
    result: Record<string, unknown> | undefined,
    ctx: { stderr: string; quotaExhausted?: boolean | undefined; fallback?: RunErrorKind },
  ): RunErrorKind {
    const status = typeof result?.api_error_status === 'number' ? result.api_error_status : null;
    const api = this.apiError;
    if ((api && ASSISTANT_RATE_ERRORS.has(api)) || status === 429 || ctx.quotaExhausted === true) {
      return 'rate_limit';
    }
    if ((api && ASSISTANT_AUTH_ERRORS.has(api)) || status === 401 || status === 403) return 'auth';
    return classifyText(`${this.cliText(result)}\n${ctx.stderr}`, ctx.fallback ?? 'crash');
  }

  /** Result text and errors when they can only be Claude Code's own ('' once the model spoke). */
  cliText(result: Record<string, unknown> | undefined): string {
    if (!result || this.modelSpoke) return '';
    const errors = Array.isArray(result.errors)
      ? result.errors.filter((e): e is string => typeof e === 'string')
      : [];
    return [str(result.result) ?? '', ...errors].join('\n');
  }
}

/** The receipt candidate: `structured_output`, else the JSON object in the `result` text. */
function finalOf(result: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isPlainObject(result.structured_output)) return result.structured_output;
  const text = str(result.result);
  return text === undefined ? undefined : extractReceiptObject(text);
}

export class ClaudeStream implements StreamParser {
  sessionRef: string | undefined;
  quota: RunQuota | undefined;
  result: Record<string, unknown> | undefined;
  readonly signals = new ClaudeErrorSignals();

  /** `system` (init) with the session id is the first agent event. */
  started(event: Record<string, unknown> | undefined): { sessionRef?: string } | undefined {
    if (event?.type !== 'system' || typeof event.session_id !== 'string') return undefined;
    return { sessionRef: event.session_id };
  }

  line(event: Record<string, unknown> | undefined): boolean {
    if (!event) return false;
    this.signals.observe(event);
    const type = str(event.type);
    if (type === 'system' && typeof event.session_id === 'string') {
      this.sessionRef ??= event.session_id;
    } else if (type === 'rate_limit_event') {
      this.quota = parseClaudeRateLimit(event.rate_limit_info) ?? this.quota;
    } else if (type === 'result') {
      this.result = event;
      if (typeof event.session_id === 'string') this.sessionRef = event.session_id;
      return true;
    }
    return false;
  }

  partial(): Omit<RunResult, 'error' | 'final'> {
    const r = this.result;
    const u = r ? claudeUsage(r.usage) : undefined;
    const cost = r ? nonNegNumber(r.total_cost_usd) : undefined;
    return {
      ...(u ? { usage: u } : {}),
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(this.sessionRef ? { sessionRef: this.sessionRef } : {}),
      ...(this.quota ? { quota: this.quota } : {}),
    };
  }

  finish({ child, stderrTail }: { child: ChildResult; stderrTail: string[] }): RunResult {
    const base = this.partial();
    const r = this.result;
    const stderr = stderrTail.join('\n');
    if (!r) {
      const tail = lastLine(stderrTail);
      const kind = this.signals.kind(undefined, { stderr, quotaExhausted: this.quota?.exhausted });
      const msg =
        child.exitCode === 0
          ? `claude exited without a result event${tail ? `: ${tail}` : ''}`
          : `claude exited with ${child.signal ?? `code ${child.exitCode}`}${tail ? `: ${tail}` : ''}`;
      return this.withLimit(errorResult(kind, msg, base), stderr);
    }
    const subtype = str(r.subtype);
    const isError = r.is_error === true || (subtype !== undefined && subtype !== 'success');
    if (isError) {
      const errors = Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === 'string') : [];
      const message =
        str(r.result)?.trim() || errors.join('; ') || subtype || 'claude reported an error';
      const fallback = subtype === 'error_max_structured_output_retries' ? 'bad_output' : 'crash';
      const kind = this.signals.kind(r, {
        stderr,
        quotaExhausted: this.quota?.exhausted,
        fallback,
      });
      // the reset time is read from text only when that text is Claude Code's own
      return this.withLimit(
        errorResult(kind, `claude: ${message}`, base),
        `${this.signals.cliText(r)}\n${stderr}`,
      );
    }
    const final = finalOf(r);
    if (!final) {
      return errorResult('bad_output', 'claude ended without a JSON object in its result', base);
    }
    return { ...base, final };
  }

  /** A rate-limited run means the window is exhausted; keep the reset time when known. */
  private withLimit(result: RunResult, text: string): RunResult {
    if (result.error?.kind !== 'rate_limit') return result;
    const resetsAt = this.quota?.resetsAt ?? resetFromMessage(text);
    const q = quota({ utilization: 1, resetsAt, exhausted: true });
    return q ? { ...result, quota: q } : result;
  }
}
