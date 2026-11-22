import { readFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import type { Logger, Resumable, Runner, RunHooks } from '@agent-team/core';
import type { RunnerCapabilities, RunResult, RunSpec } from '@agent-team/schema';
import { errorResult, startTimeoutResult, unstartedResult } from '../classify.js';
import { capture, parseHelpFlags } from '../process/capture.js';
import { childEnv } from '../process/env.js';
import { siblingScript } from '../process/module-path.js';
import { RunLog } from '../process/run-log.js';
import { groupAlive, killGroup } from '../process/spawn.js';
import { makeRedactor, redactSecrets } from '../redact.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { readProcessStart } from '../process/control.js';
import { resolveBundledCodex, type CodexBinary } from './binary.js';
import { WORKER_GIT_ENV } from '../claude/sandbox.js';
import { codexSandboxArgs } from './sandbox.js';
import { CodexStream } from './stream.js';

export interface CodexRunnerOptions {
  /**
   * argv prefix that replaces the bundled binary (tests: the scripted fake CLI). The SDK's
   * arguments are appended to it.
   */
  command?: readonly string[];
  logger?: Logger;
  sourceEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  /** Service-wide sandbox deny list (docs/adr/0014). */
  sandbox?: SandboxPolicy;
}

/** Codex keeps its ChatGPT login under CODEX_HOME (default ~/.codex); no API keys are passed. */
const CODEX_ENV_NAMES = ['CODEX_HOME'];
/**
 * `codex exec` flags the SDK 0.171.0 passes (checked by the probe). The SDK's
 * `--experimental-json` is a hidden alias of the listed `--json`, so either one counts.
 */
export const CODEX_EXEC_FLAGS = [
  '--model',
  '--sandbox',
  '--cd',
  '--skip-git-repo-check',
  '--output-schema',
  '--config',
] as const;
const CODEX_JSON_FLAGS = ['--experimental-json', '--json'] as const;
/**
 * Isolation from the user's own Codex setup (docs/adr/0011): `--ignore-user-config` skips
 * `$CODEX_HOME/config.toml` (MCP servers, plugins, apps; the ChatGPT login in `CODEX_HOME` still
 * works) and `--ignore-rules` skips execpolicy `.rules`. Passed after `exec` by the group wrapper.
 * Required: a CLI whose `codex exec --help` lacks either makes the runner unavailable.
 */
export const CODEX_ISOLATION_FLAGS = ['--ignore-user-config', '--ignore-rules'] as const;
/**
 * What research runs need on top (spec §17): `--disable <feature>` removes the shell and every
 * other non-search tool. Without it the probe reports `webSearch: false`.
 */
export const CODEX_WEB_FLAGS = ['--disable'] as const;
/** `--config` overrides for every run: no skill catalogue in the prompt (docs/adr/0011). */
export const CODEX_CONFIG_OVERRIDES = { skills: { include_instructions: false } } as const;

export const CODEX_SHIM_FILE = 'codex-exec.mjs';
export const CODEX_PGID_FILE = 'codex.pgid';

/** Writes the executable shim the SDK starts instead of the binary (see group-wrapper.ts). */
async function writeShim(dir: string): Promise<string> {
  const wrapper = siblingScript(import.meta.url, 'group-wrapper');
  const node = /^[\w./+-]+$/.test(process.execPath) ? process.execPath : '/usr/bin/env node';
  const shim = join(dir, CODEX_SHIM_FILE);
  await writeFile(shim, `#!${node}\nimport ${JSON.stringify(pathToFileURL(wrapper).href)};\n`, {
    mode: 0o700,
  });
  await chmod(shim, 0o700);
  return shim;
}

function readPgid(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

export class CodexRunner implements Runner, Resumable {
  readonly name = 'codex' as const;
  readonly resumable = true as const;
  private last: RunnerCapabilities | undefined;
  private isolation: string[] = [];

  constructor(private readonly opts: CodexRunnerOptions = {}) {}

  private binary(): { cmd: string[]; pathDirs: string[] } {
    if (this.opts.command && this.opts.command.length > 0) {
      return { cmd: [...this.opts.command], pathDirs: [] };
    }
    const bin: CodexBinary = resolveBundledCodex();
    return { cmd: [bin.executable], pathDirs: bin.pathDirs };
  }

  private env(pathDirs: string[], extra: Record<string, string> = {}): Record<string, string> {
    const env = childEnv(CODEX_ENV_NAMES, extra, this.opts.sourceEnv ?? process.env);
    if (pathDirs.length > 0) env.PATH = [...pathDirs, env.PATH].filter(Boolean).join(delimiter);
    return env;
  }

  get capabilities(): RunnerCapabilities | undefined {
    return this.last;
  }

  async probe(): Promise<RunnerCapabilities> {
    const unavailable = (problem: string): RunnerCapabilities => ({
      runner: 'codex',
      available: false,
      credentials: 'unknown',
      supports: {
        jsonSchema: true,
        resume: true,
        quota: false,
        effort: true,
        readOnly: true,
        webSearch: false,
      },
      flags: [],
      problems: [redactSecrets(problem)],
    });
    let bin: { cmd: string[]; pathDirs: string[] };
    try {
      bin = this.binary();
    } catch (err) {
      return (this.last = unavailable((err as Error).message));
    }
    const [exe, ...prefix] = bin.cmd as [string, ...string[]];
    const io = { env: this.env(bin.pathDirs), cwd: tmpdir() };
    const version = await capture(exe, [...prefix, '--version'], io);
    if (!version.ok) {
      return (this.last = unavailable(
        version.failure ?? `codex --version exited ${version.exitCode}`,
      ));
    }
    const help = await capture(exe, [...prefix, 'exec', '--help'], io);
    const found = parseHelpFlags(`${help.stdout}\n${help.stderr}`);
    // codex prints the login state without secrets on success; only the exit status is used
    const login = await capture(exe, [...prefix, 'login', 'status'], io);
    const credentials = login.failure ? 'unknown' : login.exitCode === 0 ? 'ready' : 'missing';
    const problems: string[] = [];
    const missing: string[] = CODEX_EXEC_FLAGS.filter((f) => !found.has(f));
    const json = CODEX_JSON_FLAGS.filter((f) => found.has(f));
    if (json.length === 0) missing.push('--json');
    // required (docs/adr/0011): without them the user's config.toml and rules would apply
    this.isolation = CODEX_ISOLATION_FLAGS.filter((flag) => found.has(flag));
    for (const flag of CODEX_ISOLATION_FLAGS.filter((x) => !found.has(x))) {
      missing.push(flag);
    }
    for (const f of missing) {
      const isolation = (CODEX_ISOLATION_FLAGS as readonly string[]).includes(f);
      problems.push(`${isolation ? 'required ' : ''}codex exec flag ${f} not supported`);
    }
    if (credentials === 'missing') problems.push('codex is not logged in (run `codex login`)');
    const web = CODEX_WEB_FLAGS.filter((f) => found.has(f));
    if (web.length < CODEX_WEB_FLAGS.length) {
      problems.push('codex exec flag --disable not supported: no research runs');
    }
    this.last = {
      runner: 'codex',
      available: missing.length === 0 && credentials !== 'missing',
      version: version.stdout.split('\n')[0]!.trim(),
      executable: exe,
      credentials,
      supports: {
        jsonSchema: true,
        resume: true,
        quota: false,
        effort: true,
        readOnly: true,
        webSearch: web.length === CODEX_WEB_FLAGS.length,
      },
      flags: [
        ...json,
        ...CODEX_EXEC_FLAGS.filter((f) => found.has(f)),
        ...this.isolation,
        ...web,
      ].sort(),
      problems,
    };
    return this.last;
  }

  async run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunResult> {
    const redact = makeRedactor();
    const safe = (r: RunResult): RunResult =>
      r.error ? { ...r, error: { ...r.error, message: redact(r.error.message) } } : r;
    if (signal.aborted) return errorResult('cancelled', 'codex run cancelled before start');
    const caps = this.last ?? (await this.probe());
    if (!caps.available) {
      const kind = caps.credentials === 'missing' ? 'auth' : 'crash';
      return errorResult(kind, `codex unavailable: ${caps.problems.join('; ')}`);
    }
    if (spec.web === true && !caps.supports.webSearch) {
      return errorResult('crash', 'codex cannot run research runs here (no --disable flag)');
    }

    let log: RunLog | undefined;
    let shim: string;
    let bin: { cmd: string[]; pathDirs: string[] };
    try {
      bin = this.binary();
      log = await RunLog.open(spec.logDir, redact);
      await log.writePrompt(spec.prompt);
      shim = await writeShim(spec.logDir);
    } catch (err) {
      await log?.close();
      return safe(errorResult('crash', `codex: cannot prepare run: ${(err as Error).message}`));
    }
    const pgidFile = join(spec.logDir, CODEX_PGID_FILE);
    const env = this.env(bin.pathDirs, {
      ...spec.env,
      // the profile denies ~/.config and ~/.gitconfig: without this every git command of the
      // worker warns "unable to access …/.config/git/ignore" (2026-11-21 validation)
      ...WORKER_GIT_ENV,
      AGENT_TEAM_REAL_CMD: JSON.stringify(bin.cmd),
      AGENT_TEAM_EXEC_ARGS: JSON.stringify([
        ...this.isolation,
        ...codexSandboxArgs(spec, this.opts.sandbox ?? { denyPaths: [] }),
      ]),
      AGENT_TEAM_PGID_FILE: pgidFile,
      AGENT_TEAM_KILL_GRACE_MS: String(this.opts.killGraceMs ?? 5000),
    });

    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) ac.abort(signal.reason); // aborted while preparing
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error('timeout'));
    }, spec.timeoutMs);

    const stream = new CodexStream();
    let started = false;
    let result: RunResult;
    try {
      const codex = new Codex({ codexPathOverride: shim, env, config: CODEX_CONFIG_OVERRIDES });
      const options: ThreadOptions = {
        workingDirectory: spec.cwd,
        // no sandboxMode: `--sandbox` would replace the permission profile (codex/sandbox.ts)
        approvalPolicy: 'never',
        model: spec.model,
        skipGitRepoCheck: true,
        ...(spec.effort === undefined ? {} : { modelReasoningEffort: spec.effort }),
      };
      const thread = spec.resumeRef
        ? codex.resumeThread(spec.resumeRef, options)
        : codex.startThread(options);
      // the SDK spawns the wrapper inside runStreamed: record the launch first (docs/adr/0015)
      try {
        hooks?.onLaunching?.();
      } catch {
        // a throwing hook must not turn into an unhandled error
      }
      const { events } = await thread.runStreamed(spec.prompt, {
        outputSchema: spec.schema,
        signal: ac.signal,
      });
      for await (const ev of events) {
        log.eventObject(ev);
        const threadId = stream.event(ev);
        if (threadId !== undefined && !started) {
          started = true;
          const pid = readPgid(pgidFile);
          const pidStartedAt = pid === undefined ? undefined : await readProcessStart(pid);
          const known = pidStartedAt === undefined ? {} : { pidStartedAt };
          try {
            if (pid !== undefined) hooks?.onSpawned?.({ pid, ...known });
            hooks?.onStarted?.({
              sessionRef: threadId,
              ...(pid === undefined ? {} : { pid, ...known }),
            });
          } catch {
            // a throwing hook must not turn into an unhandled error
          }
        }
      }
      result = stream.finish();
      // no `thread.started`: did codex do anything? (docs/adr/0010)
      if (!started) {
        result = unstartedResult(result, {
          label: 'codex',
          text: '',
          refused: stream.failure !== undefined,
        });
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (timedOut) {
        result = started
          ? errorResult('timeout', `codex timed out after ${spec.timeoutMs} ms`, stream.partial())
          : startTimeoutResult('codex', spec.timeoutMs);
      } else if (signal.aborted) {
        result = errorResult('cancelled', 'codex run cancelled', stream.partial());
      } else {
        for (const line of message.split('\n')) log.stderrLine(line);
        result = stream.failure ? stream.failed(stream.failure) : stream.failed(message);
        if (!started) {
          result = unstartedResult(result, {
            label: 'codex',
            text: redact(message),
            refused: stream.failure !== undefined,
          });
        }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // the SDK only signals the wrapper; make sure the whole codex group is gone
      const pgid = readPgid(pgidFile);
      if (pgid !== undefined && groupAlive(pgid)) await killGroup(pgid, this.opts.killGraceMs);
      await log.close();
    }
    this.opts.logger?.debug('codex run finished', {
      dispatch_id: spec.dispatchId,
      error: result.error?.kind ?? null,
    });
    return safe(result);
  }
}
