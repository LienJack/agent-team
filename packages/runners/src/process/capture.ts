import { runChild } from './spawn.js';

/** Output of a short helper command (`--version`, `--help`, `auth status`). */
export interface Captured {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be started or timed out. */
  failure?: string;
}

const MAX_CAPTURE_LINES = 5000;

/** Run a probe command with stdin closed and a short timeout; never rejects. */
export async function capture(
  command: string,
  args: readonly string[],
  opts: { env: Record<string, string>; cwd: string; timeoutMs?: number },
): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const res = await runChild({
    command,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 15_000,
    killGraceMs: 1000,
    onStdoutLine: (l) => {
      if (stdout.length < MAX_CAPTURE_LINES) stdout.push(l);
    },
    onStderrLine: (l) => {
      if (stderr.length < MAX_CAPTURE_LINES) stderr.push(l);
    },
  });
  const failure =
    res.reason === 'spawn_error'
      ? `cannot start ${command}: ${res.spawnError?.code ?? 'error'}`
      : res.reason === 'timeout'
        ? `${command} ${args.join(' ')} timed out`
        : undefined;
  return {
    ok: failure === undefined && res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    ...(failure ? { failure } : {}),
  };
}

/** Long options (`--foo-bar`) and short `-p` style options mentioned in a CLI help text. */
export function parseHelpFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const m of help.matchAll(
    /(?:^|[\s,[(])(--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z])(?=[\s,=<[\]).]|$)/gm,
  )) {
    flags.add(m[1]!);
  }
  return flags;
}
