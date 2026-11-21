import { spawn, type ChildProcess } from 'node:child_process';
import { LineSplitter } from './lines.js';

// Shared child-process utility (spec §7 共同要求): argv arrays only (never a shell string),
// explicit stdin (closed, or written then closed), its own process group, the whole group killed
// on timeout/abort (SIGTERM, then SIGKILL after a grace period), and completion = the agent's end
// signal or the process exit, whichever comes first.

export interface ChildSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The complete child environment (build it with `childEnv`; nothing is inherited). */
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed. Omitted → stdin is closed from the start. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** SIGTERM → SIGKILL grace (default 5000 ms). */
  killGraceMs?: number;
  /** After the end signal, how long the process may take to exit by itself (default 3000 ms). */
  endGraceMs?: number;
  /** Called once with the pid as soon as the process is spawned. */
  onSpawn?: (pid: number) => void;
  /** One complete stdout line; return `'end'` when it is the agent's end signal. */
  onStdoutLine?: (line: string) => void | 'end';
  onStderrLine?: (line: string) => void;
}

export type ChildEndReason = 'exit' | 'end_signal' | 'timeout' | 'aborted' | 'spawn_error';

export interface ChildResult {
  /** What ended the wait (the first of these to happen). */
  reason: ChildEndReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid?: number;
  /** Set when the process could not be started (e.g. `ENOENT`). */
  spawnError?: { code: string; message: string };
  durationMs: number;
}

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_END_GRACE_MS = 3000;

function errnoCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/** Send `sig` to the whole process group led by `pid`; false when the group is gone. */
export function signalGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

/** Whether any process of the group led by `pid` is still alive. */
export function groupAlive(pid: number): boolean {
  return signalGroup(pid, 0);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SIGTERM the group, wait up to `graceMs` for every member to exit, then SIGKILL whatever is
 * left. Resolves once the group is gone (or after the SIGKILL when it cannot be observed).
 */
export async function killGroup(pid: number, graceMs = DEFAULT_KILL_GRACE_MS): Promise<void> {
  if (!signalGroup(pid, 'SIGTERM')) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(25);
    if (!groupAlive(pid)) return;
  }
  signalGroup(pid, 'SIGKILL');
  const hardDeadline = Date.now() + 1000;
  while (Date.now() < hardDeadline && groupAlive(pid)) await sleep(25);
}

/** Run one child to completion. Never rejects. */
export function runChild(spec: ChildSpec): Promise<ChildResult> {
  const started = Date.now();
  const killGrace = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const endGrace = spec.endGraceMs ?? DEFAULT_END_GRACE_MS;

  return new Promise<ChildResult>((resolve) => {
    let reason: ChildEndReason | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: ChildResult['spawnError'];
    let exited = false;
    let closed = false;
    let settled = false;
    let killing: Promise<void> | undefined;
    const timers = new Set<NodeJS.Timeout>();

    const after = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };
    const clearTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };

    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        detached: true, // setsid(): own session and process group; pgid === pid
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        reason: 'spawn_error',
        exitCode: null,
        signal: null,
        spawnError: { code: errnoCode(err), message: (err as Error).message },
        durationMs: Date.now() - started,
      });
      return;
    }

    const out = new LineSplitter((line) => {
      if (spec.onStdoutLine?.(line) === 'end') onEndSignal();
    });
    const err = new LineSplitter((line) => spec.onStderrLine?.(line));

    const terminate = () => {
      if (child.pid === undefined || killing) return;
      killing = killGroup(child.pid, killGrace);
    };

    const settle = () => {
      if (settled || !exited || !closed) return;
      settled = true;
      clearTimers();
      spec.signal?.removeEventListener('abort', onAbort);
      out.end();
      err.end();
      const result: ChildResult = {
        reason: reason ?? 'exit',
        exitCode,
        signal: exitSignal,
        durationMs: Date.now() - started,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        ...(spawnError ? { spawnError } : {}),
      };
      // survivors of the group (background jobs of the agent) never outlive the run
      if (child.pid !== undefined && reason !== 'spawn_error' && groupAlive(child.pid)) {
        terminate();
      }
      void (killing ?? Promise.resolve()).then(() => resolve(result));
    };

    function onEndSignal() {
      if (reason !== undefined) return;
      reason = 'end_signal';
      clearTimers();
      after(endGrace, terminate);
    }

    function onAbort() {
      if (reason !== undefined) return;
      reason = 'aborted';
      clearTimers();
      terminate();
    }

    child.once('spawn', () => {
      if (child.pid !== undefined) spec.onSpawn?.(child.pid);
    });
    child.once('error', (e) => {
      if (child.pid === undefined || exited) {
        // never started
        reason ??= 'spawn_error';
        spawnError = { code: errnoCode(e), message: e.message };
        exited = true;
        closed = true;
        settle();
      }
    });
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // a grandchild may keep the pipes open; do not wait for it forever
      after(killGrace + 1000, () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        closed = true;
        settle();
      });
      if (child.pid !== undefined && groupAlive(child.pid)) terminate();
      settle();
    });
    child.once('close', () => {
      closed = true;
      settle();
    });

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {}); // EPIPE when the child exits without reading
      child.stdin.end(spec.stdin);
    }

    after(spec.timeoutMs, () => {
      if (reason !== undefined) return;
      reason = 'timeout';
      terminate();
    });
    if (spec.signal) {
      if (spec.signal.aborted) onAbort();
      else spec.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
