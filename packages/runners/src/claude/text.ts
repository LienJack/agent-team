import type { RunErrorKind, RunQuota, Usage } from '@agent-team/schema';
import { classifyText, nonNegNumber, quota, resetFromMessage, str } from '../classify.js';
import { isPlainObject } from '../json.js';
import { capture, parseHelpFlags } from '../process/capture.js';
import { findExecutable } from '../process/env.js';
import { parseJsonLine } from '../process/lines.js';
import { RunLog } from '../process/run-log.js';
import { runChild } from '../process/spawn.js';
import { makeRedactor } from '../redact.js';
import { assertNoPermissionBypass } from './args.js';
import { claudeUsage, parseClaudeRateLimit } from './stream.js';

// One headless `claude -p --output-format stream-json --verbose` call whose answer is plain text
// (the leader's turns, `/compact`). The caller builds the argv; this module spawns it with the
// shared child-process utility (argv array, stdin written then closed, own process group killed
// on timeout/abort) and reads the stream: session id, final text, usage, the context size of the
// last model call, compaction, quota, the Bash commands requested and the ones refused.

export interface ClaudeTextInput {
  command: string;
  /** argv after the executable (never a permission-skipping flag; checked). */
  args: readonly string[];
  cwd: string;
  /** The complete child environment (build it with `childEnv`). */
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed. */
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Writes prompt.md, events.jsonl and stderr.log there (redacted); omitted = no log. */
  logDir?: string;
  /** Literal values to mask in logs and messages. */
  secrets?: readonly string[];
}

export interface ClaudeTextResult {
  /** The answer (`result.result`) of a successful call. */
  text?: string;
  sessionRef?: string;
  /** The CLI emitted its first event (the conversation exists from here on). */
  started: boolean;
  /** Summed over every model call of the turn. */
  usage?: Usage;
  costUsd?: number;
  /** Context size of the last model call: input + cache read + cache write + output tokens. */
  contextTokens?: number;
  /** Set when the turn compacted the conversation (`/compact`). */
  compacted?: { preTokens?: number; postTokens?: number };
  quota?: RunQuota;
  /** Bash commands the model requested, in order. */
  commands: string[];
  /** Bash commands the permission system refused. */
  denied: string[];
  error?: { kind: RunErrorKind; message: string };
}

const STDERR_TAIL = 40;
const MAX_MESSAGE = 2000;

function sum(...values: unknown[]): number | undefined {
  let total = 0;
  let any = false;
  for (const v of values) {
    const n = nonNegNumber(v);
    if (n !== undefined) {
      total += n;
      any = true;
    }
  }
  return any ? Math.round(total) : undefined;
}

/** Stream state of one text call. */
class TextStream {
  sessionRef: string | undefined;
  started = false;
  quota: RunQuota | undefined;
  result: Record<string, unknown> | undefined;
  contextTokens: number | undefined;
  compacted: ClaudeTextResult['compacted'];
  readonly commands: string[] = [];

  line(event: Record<string, unknown> | undefined): boolean {
    if (!event) return false;
    const type = str(event.type);
    if (typeof event.session_id === 'string') {
      this.started = true;
      this.sessionRef ??= event.session_id;
    }
    if (type === 'system' && event.subtype === 'compact_boundary') {
      const meta = isPlainObject(event.compact_metadata) ? event.compact_metadata : {};
      const pre = nonNegNumber(meta.pre_tokens);
      const post = nonNegNumber(meta.post_tokens);
      this.compacted = {
        ...(pre === undefined ? {} : { preTokens: pre }),
        ...(post === undefined ? {} : { postTokens: post }),
      };
      if (post !== undefined) this.contextTokens = post;
    } else if (type === 'rate_limit_event') {
      this.quota = parseClaudeRateLimit(event.rate_limit_info) ?? this.quota;
    } else if (type === 'assistant' && isPlainObject(event.message)) {
      const message = event.message;
      if (isPlainObject(message.usage)) {
        const u = message.usage;
        const size = sum(
          u.input_tokens,
          u.cache_read_input_tokens,
          u.cache_creation_input_tokens,
          u.output_tokens,
        );
        if (size !== undefined) this.contextTokens = size;
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isPlainObject(block) || block.type !== 'tool_use' || block.name !== 'Bash') continue;
        const command = isPlainObject(block.input) ? str(block.input.command) : undefined;
        if (command !== undefined) this.commands.push(command);
      }
    } else if (type === 'result') {
      this.result = event;
      if (typeof event.session_id === 'string') this.sessionRef = event.session_id;
      return true;
    }
    return false;
  }

  denied(): string[] {
    const list = this.result?.permission_denials;
    if (!Array.isArray(list)) return [];
    return list.flatMap((d) => {
      const command = isPlainObject(d) && isPlainObject(d.tool_input) ? d.tool_input.command : '';
      return typeof command === 'string' && command !== '' ? [command] : [];
    });
  }
}

function base(stream: TextStream): ClaudeTextResult {
  const r = stream.result;
  const usage = r ? claudeUsage(r.usage) : undefined;
  const cost = r ? nonNegNumber(r.total_cost_usd) : undefined;
  return {
    started: stream.started,
    commands: [...stream.commands],
    denied: stream.denied(),
    ...(stream.sessionRef ? { sessionRef: stream.sessionRef } : {}),
    ...(usage ? { usage } : {}),
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(stream.contextTokens === undefined ? {} : { contextTokens: stream.contextTokens }),
    ...(stream.compacted ? { compacted: stream.compacted } : {}),
    ...(stream.quota ? { quota: stream.quota } : {}),
  };
}

function failed(
  result: ClaudeTextResult,
  kind: RunErrorKind,
  message: string,
  limitText = '',
): ClaudeTextResult {
  const out: ClaudeTextResult = {
    ...result,
    error: { kind, message: message.slice(0, MAX_MESSAGE) },
  };
  if (kind !== 'rate_limit') return out;
  const resetsAt = result.quota?.resetsAt ?? resetFromMessage(limitText);
  const q = quota({ utilization: 1, resetsAt, exhausted: true });
  return q ? { ...out, quota: q } : out;
}

/** Run one text call to completion. Never rejects. */
export async function runClaudeText(input: ClaudeTextInput): Promise<ClaudeTextResult> {
  const redact = makeRedactor(input.secrets ?? []);
  const empty: ClaudeTextResult = { started: false, commands: [], denied: [] };
  try {
    assertNoPermissionBypass(input.args);
  } catch (err) {
    return failed(empty, 'crash', (err as Error).message);
  }
  if (input.signal?.aborted)
    return failed(empty, 'cancelled', 'claude call cancelled before start');
  let log: RunLog | undefined;
  if (input.logDir !== undefined) {
    try {
      log = await RunLog.open(input.logDir, redact);
      await log.writePrompt(input.prompt);
    } catch {
      await log?.close();
      log = undefined; // logging is best effort for text calls
    }
  }
  const stream = new TextStream();
  const stderrTail: string[] = [];
  try {
    const child = await runChild({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
      onStdoutLine: (raw) => {
        log?.event(raw);
        return stream.line(parseJsonLine(raw)) ? 'end' : undefined;
      },
      onStderrLine: (line) => {
        log?.stderrLine(line);
        stderrTail.push(redact(line));
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
      },
    });
    const partial = base(stream);
    const stderr = stderrTail.join('\n');
    switch (child.reason) {
      case 'spawn_error':
        return failed(
          partial,
          'crash',
          `cannot start claude: ${child.spawnError?.code ?? 'error'}`,
        );
      case 'timeout':
        return failed(partial, 'timeout', `claude timed out after ${input.timeoutMs} ms`);
      case 'aborted':
        return failed(partial, 'cancelled', 'claude call cancelled');
      default:
        break;
    }
    const r = stream.result;
    if (!r) {
      const tail = stderrTail.findLast((l) => l.trim() !== '') ?? '';
      const how =
        child.exitCode === 0
          ? 'without a result event'
          : `with ${child.signal ?? `code ${child.exitCode}`}`;
      return failed(
        partial,
        classifyText(stderr),
        redact(`claude exited ${how}${tail ? `: ${tail}` : ''}`),
        stderr,
      );
    }
    const subtype = str(r.subtype);
    if (r.is_error === true || (subtype !== undefined && subtype !== 'success')) {
      const errors = Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === 'string') : [];
      const message =
        str(r.result)?.trim() || errors.join('; ') || subtype || 'claude reported an error';
      const kind = stream.quota?.exhausted ? 'rate_limit' : classifyText(`${message}\n${stderr}`);
      return failed(partial, kind, redact(`claude: ${message}`), message);
    }
    return { ...partial, text: str(r.result) ?? '' };
  } catch (err) {
    return failed(base(stream), 'crash', redact(`claude: ${(err as Error).message}`));
  } finally {
    await log?.close();
  }
}

export interface ClaudeProbe {
  available: boolean;
  executable?: string;
  version?: string;
  /** The flags of `wanted` that `claude --help` lists. */
  flags: Set<string>;
  /** From `claude auth status --json` (`loggedIn` only); undefined when unknown. */
  loggedIn?: boolean;
  problems: string[];
}

/**
 * `claude --version`, `--help` (which of `wanted` are supported) and `auth status --json`
 * (only the `loggedIn` boolean is read). `required` flags missing → unavailable.
 */
export async function probeClaudeCli(opts: {
  command?: readonly string[];
  env: Record<string, string>;
  cwd: string;
  wanted: readonly string[];
  required: readonly string[];
}): Promise<ClaudeProbe> {
  const prefix = opts.command && opts.command.length > 0 ? [...opts.command] : undefined;
  const exe = prefix ? prefix[0]! : findExecutable('claude', opts.env.PATH);
  const rest = prefix ? prefix.slice(1) : [];
  if (exe === undefined) {
    return {
      available: false,
      flags: new Set(),
      problems: ['claude executable not found on PATH'],
    };
  }
  const io = { env: opts.env, cwd: opts.cwd };
  const version = await capture(exe, [...rest, '--version'], io);
  if (!version.ok) {
    return {
      available: false,
      executable: exe,
      flags: new Set(),
      problems: [version.failure ?? `claude --version exited ${version.exitCode}`],
    };
  }
  const help = await capture(exe, [...rest, '--help'], io);
  const found = parseHelpFlags(`${help.stdout}\n${help.stderr}`);
  if (found.has('--allowed-tools')) found.add('--allowedTools');
  if (found.has('-p')) found.add('--print');
  const flags = new Set(opts.wanted.filter((f) => found.has(f)));
  const problems = opts.required
    .filter((f) => !found.has(f))
    .map((f) => `required flag ${f} not supported`);
  let loggedIn: boolean | undefined;
  const auth = await capture(exe, [...rest, 'auth', 'status', '--json'], io);
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === 'boolean') loggedIn = parsed.loggedIn;
  } catch {
    // older CLIs: unknown
  }
  return {
    available: problems.length === 0,
    executable: exe,
    version: version.stdout.split('\n')[0]!.trim(),
    flags,
    ...(loggedIn === undefined ? {} : { loggedIn }),
    problems,
  };
}
