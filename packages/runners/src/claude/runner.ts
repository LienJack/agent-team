import { tmpdir } from 'node:os';
import type { Logger, Resumable, Runner, RunHooks } from '@agent-team/core';
import type { RunnerCapabilities, RunResult, RunSpec } from '@agent-team/schema';
import { errorResult } from '../classify.js';
import { runCli } from '../cli-driver.js';
import { capture, parseHelpFlags } from '../process/capture.js';
import { childEnv, findExecutable } from '../process/env.js';
import { redactSecrets } from '../redact.js';
import { CLAUDE_OPTIONAL_FLAGS, CLAUDE_REQUIRED_FLAGS, claudeArgs } from './args.js';
import { WORKER_GIT_ENV, type SandboxPolicy } from './sandbox.js';
import { ClaudeStream } from './stream.js';

export interface ClaudeRunnerOptions {
  /** argv prefix of the executable (default: `claude` on PATH). Tests use the scripted fake. */
  command?: readonly string[];
  logger?: Logger;
  /** Environment the allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Service-wide sandbox deny list (docs/adr/0014); default: credentials under home only. */
  sandbox?: SandboxPolicy;
}

/** Non-secret claude variables passed through (its own config home); no API keys. */
const CLAUDE_ENV_NAMES = ['CLAUDE_CONFIG_DIR'];

export class ClaudeRunner implements Runner, Resumable {
  readonly name = 'claude' as const;
  readonly resumable = true as const;
  private last: RunnerCapabilities | undefined;
  private flags = new Set<string>();

  constructor(private readonly opts: ClaudeRunnerOptions = {}) {}

  private env(extra: Record<string, string> = {}): Record<string, string> {
    return childEnv(CLAUDE_ENV_NAMES, extra, this.opts.sourceEnv ?? process.env);
  }

  private command(): [string, string[]] | undefined {
    if (this.opts.command && this.opts.command.length > 0) {
      return [this.opts.command[0]!, this.opts.command.slice(1)];
    }
    const exe = findExecutable('claude', this.env().PATH);
    return exe ? [exe, []] : undefined;
  }

  get capabilities(): RunnerCapabilities | undefined {
    return this.last;
  }

  async probe(): Promise<RunnerCapabilities> {
    const problems: string[] = [];
    const cmd = this.command();
    const unavailable = (problem: string): RunnerCapabilities => ({
      runner: 'claude',
      available: false,
      credentials: 'unknown',
      supports: { jsonSchema: false, resume: false, quota: false, effort: false, readOnly: false },
      flags: [],
      problems: [problem],
    });
    if (!cmd) return (this.last = unavailable('claude executable not found on PATH'));
    const [exe, prefix] = cmd;
    const io = { env: this.env(), cwd: tmpdir() };
    const version = await capture(exe, [...prefix, '--version'], io);
    if (!version.ok) {
      return (this.last = unavailable(
        version.failure ?? `claude --version exited ${version.exitCode}`,
      ));
    }
    const help = await capture(exe, [...prefix, '--help'], io);
    const found = parseHelpFlags(`${help.stdout}\n${help.stderr}`);
    if (found.has('--allowed-tools')) found.add('--allowedTools');
    if (found.has('-p')) found.add('--print');
    const missing = CLAUDE_REQUIRED_FLAGS.filter((f) => !found.has(f));
    for (const f of missing) problems.push(`required flag ${f} not supported`);
    for (const f of CLAUDE_OPTIONAL_FLAGS) {
      if (!found.has(f)) problems.push(`optional flag ${f} not supported; not passed`);
    }
    this.flags = new Set(
      [...CLAUDE_REQUIRED_FLAGS, ...CLAUDE_OPTIONAL_FLAGS].filter((f) => found.has(f)),
    );

    // credential readiness without values: only the `loggedIn` boolean is read
    let credentials: RunnerCapabilities['credentials'] = 'unknown';
    const auth = await capture(exe, [...prefix, 'auth', 'status', '--json'], io);
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === 'boolean') {
        credentials = parsed.loggedIn ? 'ready' : 'missing';
      }
    } catch {
      // older CLIs: unknown
    }
    if (credentials === 'missing') problems.push('claude is not logged in (run `claude /login`)');

    this.last = {
      runner: 'claude',
      available: missing.length === 0 && credentials !== 'missing',
      version: version.stdout.split('\n')[0]!.trim(),
      executable: exe,
      credentials,
      supports: {
        jsonSchema: found.has('--json-schema'),
        resume: found.has('--resume'),
        quota: true,
        effort: found.has('--effort'),
        readOnly: found.has('--allowedTools'),
      },
      flags: [...this.flags].sort(),
      problems: problems.map((p) => redactSecrets(p)),
    };
    return this.last;
  }

  async run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunResult> {
    const caps = this.last ?? (await this.probe());
    const cmd = this.command();
    if (!caps.available || !cmd) {
      const kind = caps.credentials === 'missing' ? 'auth' : 'crash';
      return errorResult(kind, `claude unavailable: ${caps.problems.join('; ')}`);
    }
    const [exe, prefix] = cmd;
    let args: string[];
    try {
      args = [...prefix, ...claudeArgs(spec, this.flags, this.opts.sandbox ?? { denyPaths: [] })];
    } catch (err) {
      return errorResult('crash', (err as Error).message);
    }
    const parser = new ClaudeStream();
    const result = await runCli({
      label: 'claude',
      command: exe,
      args,
      spec,
      env: this.env({ ...spec.env, ...WORKER_GIT_ENV }),
      parser,
      signal,
      hooks,
    });
    this.opts.logger?.debug('claude run finished', {
      dispatch_id: spec.dispatchId,
      error: result.error?.kind ?? null,
    });
    return result;
  }
}
