import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Logger, Resumable, Runner, RunHooks } from '@agent-team/core';
import {
  DSH_CHILD_ENV,
  type RunnerCapabilities,
  type RunResult,
  type RunSpec,
} from '@agent-team/schema';
import { errorResult } from '../classify.js';
import { runCli } from '../cli-driver.js';
import { capture, parseHelpFlags } from '../process/capture.js';
import { childEnv, findExecutable } from '../process/env.js';
import { redactSecrets } from '../redact.js';
import type { EnvReader } from '../types.js';
import {
  DSH_OPTIONAL_FLAGS,
  DSH_PATCH_FILE,
  DSH_REQUIRED_FLAGS,
  dshArgs,
  dshPatch,
} from './args.js';
import { DshStream } from './stream.js';

export interface DshRunnerOptions {
  /** Reads `OPENROUTER_API_KEY` (the only credential dsh gets). */
  env: EnvReader;
  /** argv prefix of the executable (default: `dsh` on PATH). */
  command?: readonly string[];
  logger?: Logger;
  sourceEnv?: NodeJS.ProcessEnv;
}

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
    this.flags = new Set(
      [...DSH_REQUIRED_FLAGS, ...DSH_OPTIONAL_FLAGS].filter((f) => found.has(f)),
    );
    this.last = {
      runner: 'dsh',
      available: missing.length === 0 && credentials === 'ready',
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
    const patchPath = `${spec.logDir.replace(/\/+$/, '')}/${DSH_PATCH_FILE}`;
    const env = this.baseEnv({ ...spec.env, [KEY_NAME]: key, ...DSH_CHILD_ENV });
    const result = await runCli({
      label: 'dsh',
      command: exe,
      args: [...prefix, ...dshArgs(spec, patchPath, this.flags)],
      spec,
      env,
      parser: new DshStream(),
      signal,
      hooks,
      secrets: [key],
      prepare: async () => {
        await writeFile(patchPath, dshPatch(spec), { mode: 0o600 });
      },
    });
    this.opts.logger?.debug('dsh run finished', {
      dispatch_id: spec.dispatchId,
      error: result.error?.kind ?? null,
    });
    return result;
  }
}
