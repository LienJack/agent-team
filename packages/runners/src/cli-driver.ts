import type { RunHooks } from '@agent-team/core';
import type { RunResult, RunSpec } from '@agent-team/schema';
import { errorResult, startTimeoutResult, unstartedResult } from './classify.js';
import { parseJsonLine } from './process/lines.js';
import { readProcessStart } from './process/control.js';
import { RunLog } from './process/run-log.js';
import { runChild, type ChildResult } from './process/spawn.js';
import { makeRedactor, type Redactor } from './redact.js';

/** What a spawn-based runner (claude, dsh) knows how to do with its event stream. */
export interface StreamParser {
  /**
   * Whether `event` is the agent's first event proving it runs (claude `system` init, dsh
   * `session`); returns what it tells (session id). The driver calls `onStarted` then, not at
   * spawn: a process that dies before it may or may not have started (docs/adr/0010).
   */
  started(event: Record<string, unknown> | undefined): { sessionRef?: string } | undefined;
  /** The CLI emitted an explicit error event before starting (it refused; nothing ran). */
  refused?(): boolean;
  /** One stdout line; return true when it is the agent's end signal (e.g. claude `result`). */
  line(event: Record<string, unknown> | undefined, raw: string): boolean;
  /** Fields known so far (usage, sessionRef, quota) — kept on timeout/cancel. */
  partial(): Omit<RunResult, 'error' | 'final'>;
  /** The result after the process finished normally (exit or end signal). */
  finish(info: { child: ChildResult; stderrTail: string[] }): RunResult;
}

export interface CliRunInput {
  label: string;
  command: string;
  args: readonly string[];
  spec: RunSpec;
  env: Record<string, string>;
  parser: StreamParser;
  signal: AbortSignal;
  hooks?: RunHooks | undefined;
  /** Literal secret values to mask in logs and messages. */
  secrets?: readonly string[];
  /** Extra files to write into the log dir before spawning (e.g. the dsh patch). */
  prepare?: (log: RunLog) => Promise<void>;
  killGraceMs?: number;
  endGraceMs?: number;
}

const STDERR_TAIL = 40;

/** Spawn → stream → RunResult for one CLI run. Never rejects. */
export async function runCli(input: CliRunInput): Promise<RunResult> {
  const { spec, parser, label } = input;
  const redact: Redactor = makeRedactor(input.secrets ?? []);
  const safe = (r: RunResult): RunResult =>
    r.error ? { ...r, error: { ...r.error, message: redact(r.error.message) } } : r;

  if (input.signal.aborted) return errorResult('cancelled', `${label} run cancelled before start`);
  let log: RunLog | undefined;
  try {
    log = await RunLog.open(spec.logDir, redact);
    await log.writePrompt(spec.prompt);
    await input.prepare?.(log);
  } catch (err) {
    await log?.close();
    return safe(
      errorResult('crash', `${label}: cannot prepare log dir: ${(err as Error).message}`),
    );
  }

  const stderrTail: string[] = [];
  let pid: number | undefined;
  let pidStartedAt: string | undefined;
  let started = false;
  const safeHook = (fn: () => void) => {
    try {
      fn();
    } catch {
      // hooks run inside child-process handlers: never let them escape
    }
  };
  const markStarted = (info: { sessionRef?: string }) => {
    started = true;
    safeHook(() =>
      input.hooks?.onStarted?.({
        ...(pid === undefined ? {} : { pid }),
        ...(pidStartedAt === undefined ? {} : { pidStartedAt }),
        ...info,
      }),
    );
  };
  if (input.signal.aborted) {
    // aborted while the log dir was being prepared: never spawn
    await log.close();
    return errorResult('cancelled', `${label} run cancelled before start`);
  }
  try {
    // recorded before the spawn: a crash right after it still leaves a trace (docs/adr/0015)
    safeHook(() => input.hooks?.onLaunching?.());
    const child = await runChild({
      command: input.command,
      args: input.args,
      cwd: spec.cwd,
      env: input.env,
      stdin: spec.prompt,
      timeoutMs: spec.timeoutMs,
      signal: input.signal,
      ...(input.killGraceMs === undefined ? {} : { killGraceMs: input.killGraceMs }),
      ...(input.endGraceMs === undefined ? {} : { endGraceMs: input.endGraceMs }),
      onSpawn: (childPid) => {
        pid = childPid;
        void readProcessStart(childPid).then((startedAt) => {
          pidStartedAt = startedAt;
          safeHook(() =>
            input.hooks?.onSpawned?.({
              pid: childPid,
              ...(startedAt === undefined ? {} : { pidStartedAt: startedAt }),
            }),
          );
        });
      },
      onStdoutLine: (raw) => {
        log?.event(raw);
        const event = parseJsonLine(raw);
        if (!started) {
          const info = parser.started(event);
          if (info) markStarted(info);
        }
        return parser.line(event, raw) ? 'end' : undefined;
      },
      onStderrLine: (line) => {
        log?.stderrLine(line);
        stderrTail.push(redact(line));
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
      },
    });
    const evidence = {
      label,
      text: stderrTail.join('\n'),
      refused: parser.refused?.() === true,
    };
    switch (child.reason) {
      case 'spawn_error':
        return safe(
          errorResult(
            'crash',
            `cannot start ${label} (${input.command}): ${child.spawnError?.code ?? 'error'}`,
          ),
        );
      case 'timeout':
        if (!started) return safe(startTimeoutResult(label, spec.timeoutMs));
        return safe(
          errorResult('timeout', `${label} timed out after ${spec.timeoutMs} ms`, parser.partial()),
        );
      case 'aborted':
        return safe(errorResult('cancelled', `${label} run cancelled`, parser.partial()));
      default: {
        const result = parser.finish({ child, stderrTail });
        return safe(started ? result : unstartedResult(result, evidence));
      }
    }
  } catch (err) {
    const result = errorResult('crash', `${label}: ${(err as Error).message}`, parser.partial());
    return safe(started ? result : unstartedResult(result, { label, text: '' }));
  } finally {
    await log.close();
  }
}

/** Last non-empty stderr line, for error messages. */
export function lastLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (l) return l;
  }
  return '';
}
