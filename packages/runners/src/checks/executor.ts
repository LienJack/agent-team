import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckExecutor, CheckOutcome } from '@agent-team/core';
import { childEnv } from '../process/env.js';
import { runChild } from '../process/spawn.js';
import { makeRedactor } from '../redact.js';
import { parseCommand } from './argv.js';

export interface CheckExecutorOptions {
  /** Environment the allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}

const TAIL_LINES = 20;

/**
 * Runs one project check (spec §6 step 4) in the worktree: argv without a shell when possible
 * (see `parseCommand` for when `/bin/sh -c` is used and why), stdin closed, allow-listed
 * environment (no secrets), own process group killed on timeout. The full output (stdout and
 * stderr interleaved as they arrive, redacted) goes to `logPath`; the outcome carries the last
 * 20 lines. A missing cwd or an unwritable log rejects (infrastructure error → effect retry);
 * a command that cannot be found is a failing check (exit 127).
 */
export function createCheckExecutor(opts: CheckExecutorOptions = {}): CheckExecutor {
  const redact = makeRedactor();
  return {
    async run({ cwd, name, cmd, logPath, timeoutMs }): Promise<CheckOutcome> {
      const st = await stat(cwd);
      if (!st.isDirectory()) throw new Error(`check ${name}: cwd is not a directory: ${cwd}`);
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      const out = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        out.once('open', () => resolve());
        out.once('error', reject);
      });
      out.on('error', () => {});

      const tail: string[] = [];
      const write = (line: string) => {
        const safe = redact(line);
        out.write(`${safe}\n`);
        tail.push(safe);
        if (tail.length > TAIL_LINES) tail.shift();
      };
      const parsed = parseCommand(cmd);
      const [command, args] =
        parsed.kind === 'argv' ? [parsed.argv[0]!, parsed.argv.slice(1)] : ['/bin/sh', ['-c', cmd]];
      out.write(
        `$ ${redact(cmd)}${parsed.kind === 'shell' ? `   (sh -c: ${parsed.reason})` : ''}\n`,
      );

      const res = await runChild({
        command,
        args,
        cwd,
        env: childEnv([], { CI: '1' }, opts.sourceEnv ?? process.env),
        timeoutMs,
        ...(opts.killGraceMs === undefined ? {} : { killGraceMs: opts.killGraceMs }),
        onStdoutLine: write,
        onStderrLine: write,
      });

      let exitCode = res.exitCode;
      let passed = res.reason === 'exit' && res.exitCode === 0;
      if (res.reason === 'spawn_error') {
        exitCode = res.spawnError?.code === 'ENOENT' ? 127 : 126;
        passed = false;
        write(`cannot run ${command}: ${res.spawnError?.code ?? 'error'}`);
      } else if (res.reason === 'timeout') {
        exitCode = null;
        passed = false;
        write(`[timed out after ${timeoutMs} ms; process group killed]`);
      }
      out.write(`[exit ${exitCode ?? res.signal ?? 'killed'} in ${res.durationMs} ms]\n`);
      await new Promise<void>((resolve) => out.end(() => resolve()));
      return { passed, exitCode, tail: tail.join('\n'), durationMs: res.durationMs };
    },
  };
}
