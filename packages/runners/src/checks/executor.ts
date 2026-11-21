import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckExecutor, CheckOutcome } from '@agent-team/core';
import { childEnv } from '../process/env.js';
import { runChild } from '../process/spawn.js';
import { makeRedactor } from '../redact.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { parseCommand } from './argv.js';
import { WORKER_GIT_ENV } from '../claude/sandbox.js';
import { checkSandboxAvailable, checkSandboxProfile, SANDBOX_EXEC } from './sandbox.js';

export interface CheckExecutorOptions {
  /** Environment the allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  /**
   * Run checks under Seatbelt with this deny list (macOS; checks/sandbox.ts). Omitted, or on a
   * platform without `sandbox-exec`, checks run unsandboxed.
   */
  sandbox?: SandboxPolicy;
}

const TAIL_LINES = 20;

/** Fixed additions to the allow-listed check environment. */
const CHECK_ENV = { CI: '1', GIT_TERMINAL_PROMPT: '0' } as const;

/**
 * Runs one project check (spec §6 step 4) in the worktree: argv without a shell when possible
 * (see `parseCommand` for when `/bin/sh -c` is used and why), stdin closed, allow-listed
 * environment (no API keys, no SSH agent socket, no AGENT_TEAM_* variables or listener token,
 * no GIT_* overrides; `GIT_TERMINAL_PROMPT=0`), own process group killed on timeout or abort
 * (an aborted check rejects: the verification is retried on the next start). Checks run
 * worker-authored code unsandboxed as the service user (docs/adr/0014). The full output (stdout and
 * stderr interleaved as they arrive, redacted) goes to `logPath`; the outcome carries the last
 * 20 lines. A missing cwd or an unwritable log rejects (infrastructure error → effect retry);
 * a command that cannot be found is a failing check (exit 127).
 */
export function createCheckExecutor(opts: CheckExecutorOptions = {}): CheckExecutor {
  const redact = makeRedactor();
  return {
    async run({ cwd, name, cmd, logPath, timeoutMs, signal, repoPath }): Promise<CheckOutcome> {
      if (signal?.aborted) throw new Error(`check ${name} aborted before it started`);
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
      let [command, args] =
        parsed.kind === 'argv' ? [parsed.argv[0]!, parsed.argv.slice(1)] : ['/bin/sh', ['-c', cmd]];
      const sandboxed = opts.sandbox !== undefined && checkSandboxAvailable();
      if (sandboxed) {
        const profile = checkSandboxProfile(
          { cwd, ...(repoPath ? { repoPath } : {}) },
          opts.sandbox!,
        );
        args = ['-p', profile, command, ...args];
        command = SANDBOX_EXEC;
      }
      out.write(
        `$ ${redact(cmd)}${parsed.kind === 'shell' ? `   (sh -c: ${parsed.reason})` : ''}${sandboxed ? '   [sandboxed]' : ''}\n`,
      );

      const res = await runChild({
        command,
        args,
        cwd,
        // in the sandbox ~/.gitconfig is unreadable and git would fail: use no global config
        env: childEnv(
          [],
          sandboxed ? { ...CHECK_ENV, ...WORKER_GIT_ENV } : CHECK_ENV,
          opts.sourceEnv ?? process.env,
        ),
        timeoutMs,
        ...(signal ? { signal } : {}),
        ...(opts.killGraceMs === undefined ? {} : { killGraceMs: opts.killGraceMs }),
        onStdoutLine: write,
        onStderrLine: write,
      });

      if (res.reason === 'aborted') {
        out.write(`[aborted after ${res.durationMs} ms; process group killed]\n`);
        await new Promise<void>((resolve) => out.end(() => resolve()));
        throw new Error(`check ${name} aborted (service shutdown)`);
      }
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
