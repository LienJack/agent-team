import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Logger, Resumable, Runner, RunHooks } from '@agent-team/core';
import {
  DSH_CHILD_ENV,
  type RunnerCapabilities,
  type RunResult,
  type RunSpec,
} from '@agent-team/schema';
import { checkSandboxAvailable, SANDBOX_EXEC } from '../checks/sandbox.js';
import { errorResult } from '../classify.js';
import { runCli } from '../cli-driver.js';
import { capture, parseHelpFlags } from '../process/capture.js';
import { childEnv, findExecutable } from '../process/env.js';
import { redactSecrets } from '../redact.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import type { EnvReader } from '../types.js';
import {
  DSH_OPTIONAL_FLAGS,
  DSH_PATCH_FILE,
  DSH_REQUIRED_FLAGS,
  DSH_STATE_DIR,
  dshArgs,
  dshPatch,
} from './args.js';
import { dshSandboxProfile } from './sandbox.js';
import { DshStream } from './stream.js';

export interface DshRunnerOptions {
  /** Reads `OPENROUTER_API_KEY` (the only credential dsh gets). */
  env: EnvReader;
  /** argv prefix of the executable (default: `dsh` on PATH). */
  command?: readonly string[];
  logger?: Logger;
  sourceEnv?: NodeJS.ProcessEnv;
  /** Service-wide deny list and ports (docs/adr/0014); default: credentials under home only. */
  sandbox?: SandboxPolicy;
  /**
   * `service.json` → `runners.dsh.allow_unsandboxed`: run dsh without Seatbelt where it is not
   * available (Linux). Without it the runner is unavailable there (fail closed, docs/adr/0019).
   */
  allowUnsandboxed?: boolean;
  /** Whether `sandbox-exec` can be used (default: macOS with `/usr/bin/sandbox-exec`). */
  sandboxAvailable?: () => boolean;
}

/**
 * git in the worker ignores the global config files (denied in the sandbox: `~/.gitconfig`,
 * `~/.config/git/*`). Not WORKER_GIT_ENV: dsh's subprocess layer drops every variable whose name
 * matches /KEY|PASSWORD|SECRET|TOKEN/i, so `GIT_CONFIG_KEY_0` vanished while `GIT_CONFIG_COUNT`
 * stayed and git refused to run (2026-11-21 sanity pass). An empty per-run XDG_CONFIG_HOME
 * replaces `core.excludesFile=/dev/null`.
 */
export function dshGitEnv(stateDir: string): Record<string, string> {
  return { GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: join(stateDir, 'xdg') };
}

/** Why dsh is unavailable without its sandbox. */
export const DSH_UNSANDBOXED_PROBLEM =
  'dsh runs only under sandbox-exec (macOS): its own sandbox cannot deny reads; set runners.dsh.allow_unsandboxed: true in service.json to run it unsandboxed';

const KEY_NAME = 'OPENROUTER_API_KEY';
/** dsh's own home (profiles, sessions); not a credential. */
const DSH_ENV_NAMES = ['DSH_HOME'];

export class DshRunner implements Runner, Resumable {
  readonly name = 'dsh' as const;
  readonly resumable = true as const;
  private last: RunnerCapabilities | undefined;
  private flags = new Set<string>();

  constructor(private readonly opts: DshRunnerOptions) {}

  private baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return childEnv(DSH_ENV_NAMES, extra, this.opts.sourceEnv ?? process.env);
  }

  private command(): [string, string[]] | undefined {
    if (this.opts.command && this.opts.command.length > 0) {
      return [this.opts.command[0]!, this.opts.command.slice(1)];
    }
    const exe = findExecutable('dsh', this.baseEnv().PATH);
    return exe ? [exe, []] : undefined;
  }

  private sandboxed(): boolean {
    return (this.opts.sandboxAvailable ?? checkSandboxAvailable)();
  }

  private key(): string | undefined {
    const v = this.opts.env(KEY_NAME);
    return v === undefined || v.trim() === '' ? undefined : v;
  }

  get capabilities(): RunnerCapabilities | undefined {
    return this.last;
  }

  async probe(): Promise<RunnerCapabilities> {
    const credentials = this.key() ? 'ready' : 'missing';
    const cmd = this.command();
    const unavailable = (problem: string): RunnerCapabilities => ({
      runner: 'dsh',
      available: false,
      credentials,
      supports: { jsonSchema: false, resume: false, quota: false, effort: false, readOnly: false },
      flags: [],
      problems: [problem],
    });
    if (!cmd) return (this.last = unavailable('dsh executable not found on PATH'));
    const [exe, prefix] = cmd;
    // probes never get the key
    const io = { env: this.baseEnv({ ...DSH_CHILD_ENV }), cwd: tmpdir() };
    const version = await capture(exe, [...prefix, '--version'], io);
    if (!version.ok) {
      return (this.last = unavailable(
        version.failure ?? `dsh --version exited ${version.exitCode}`,
      ));
    }
    const top = await capture(exe, [...prefix, '--help'], io);
    const headless = await capture(exe, [...prefix, '--profile', 'headless', '--help'], io);
    const found = new Set([
      ...parseHelpFlags(`${top.stdout}\n${top.stderr}`),
      ...parseHelpFlags(`${headless.stdout}\n${headless.stderr}`),
    ]);
    const problems: string[] = [];
    const missing = DSH_REQUIRED_FLAGS.filter((f) => !found.has(f));
    for (const f of missing) problems.push(`required flag ${f} not supported`);
    for (const f of DSH_OPTIONAL_FLAGS) {
      if (!found.has(f)) problems.push(`optional flag ${f} not supported; not passed`);
    }
    if (credentials === 'missing') problems.push(`${KEY_NAME} is not set`);
    const unsandboxed = !this.sandboxed();
    if (unsandboxed) {
      problems.push(
        this.opts.allowUnsandboxed === true
          ? 'no sandbox-exec here: dsh runs UNSANDBOXED (runners.dsh.allow_unsandboxed)'
          : DSH_UNSANDBOXED_PROBLEM,
      );
    }
    const refused = unsandboxed && this.opts.allowUnsandboxed !== true;
    this.flags = new Set(
      [...DSH_REQUIRED_FLAGS, ...DSH_OPTIONAL_FLAGS].filter((f) => found.has(f)),
    );
    this.last = {
      runner: 'dsh',
      available: missing.length === 0 && credentials === 'ready' && !refused,
      version: version.stdout.split('\n')[0]!.trim(),
      executable: exe,
      credentials,
      supports: {
        jsonSchema: false, // no schema enforcement: the first JSON object of the final text is taken
        resume: found.has('--session-id'),
        quota: false,
        effort: false,
        readOnly: true,
      },
      flags: [...this.flags].sort(),
      problems: problems.map((p) => redactSecrets(p)),
    };
    return this.last;
  }

  async run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunResult> {
    const key = this.key();
    if (!key) return errorResult('auth', `${KEY_NAME} is not set`);
    const caps = this.last ?? (await this.probe());
    const cmd = this.command();
    if (!caps.available || !cmd) {
      return errorResult('crash', `dsh unavailable: ${caps.problems.join('; ')}`);
    }
    const [exe, prefix] = cmd;
    const logDir = spec.logDir.replace(/\/+$/, '');
    const patchPath = `${logDir}/${DSH_PATCH_FILE}`;
    const stateDir = join(logDir, DSH_STATE_DIR);
    const sandboxed = this.sandboxed();
    if (!sandboxed && this.opts.allowUnsandboxed !== true) {
      return errorResult('crash', `dsh unavailable: ${DSH_UNSANDBOXED_PROBLEM}`);
    }
    const env = this.baseEnv({
      ...spec.env,
      [KEY_NAME]: key,
      ...DSH_CHILD_ENV,
      ...dshGitEnv(stateDir),
    });
    const dshArgv = [...prefix, ...dshArgs(spec, patchPath, this.flags)];
    let command = exe;
    let args = dshArgv;
    if (sandboxed) {
      // the whole dsh process under Seatbelt (docs/adr/0019); its paths must exist first
      try {
        await mkdir(join(stateDir, 'xdg'), { recursive: true, mode: 0o700 });
        await chmod(logDir, 0o700);
        await chmod(stateDir, 0o700);
      } catch (err) {
        return errorResult('crash', `dsh: cannot prepare its state dir: ${(err as Error).message}`);
      }
      const profile = dshSandboxProfile(
        {
          cwd: spec.cwd,
          writable: spec.writable,
          repoPath: spec.sandbox?.repoPath,
          stateDir,
          patchPath,
          dshHome: this.baseEnv().DSH_HOME,
          executables: [exe, ...prefix.filter((p) => isAbsolute(p))],
        },
        this.opts.sandbox ?? { denyPaths: [] },
      );
      command = SANDBOX_EXEC;
      args = ['-p', profile, exe, ...dshArgv];
    }
    const result = await runCli({
      label: 'dsh',
      command,
      args,
      spec,
      env,
      parser: new DshStream(),
      signal,
      hooks,
      secrets: [key],
      prepare: async () => {
        await mkdir(join(stateDir, 'xdg'), { recursive: true, mode: 0o700 });
        await writeFile(patchPath, dshPatch(spec, stateDir, { outerSandbox: sandboxed }), {
          mode: 0o600,
        });
      },
    });
    this.opts.logger?.debug('dsh run finished', {
      dispatch_id: spec.dispatchId,
      error: result.error?.kind ?? null,
    });
    return result;
  }
}
