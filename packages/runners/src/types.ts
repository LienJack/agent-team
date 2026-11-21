import type { RunnerRegistry, Logger, Runner } from '@agent-team/core';
import type { RunnerCapabilities, RunnerName, RunResult, RunSpec } from '@agent-team/schema';
import type { SandboxPolicy } from './sandbox-policy.js';

/** Reads one environment variable (the server's single `.env`/process reader). Never logged. */
export type EnvReader = (name: string) => string | undefined;

export interface RunnerRegistryOptions {
  /** One-variable reader; runners ask only for what they need (dsh: `OPENROUTER_API_KEY`). */
  env: EnvReader;
  logger?: Logger;
  /**
   * `true` registers in-process fakes under every runner name (`claude`, `codex`, `dsh`, `fake`)
   * so models.json routing still works in end-to-end tests. Script them via `registry.fake(name)`.
   */
  fake?: boolean;
  /**
   * Per-runner executable overrides (argv prefix), e.g. the scripted fake CLI in tests. For codex
   * it replaces the SDK's bundled binary (still started by the SDK, through the group wrapper).
   */
  commands?: Partial<Record<'claude' | 'codex' | 'dsh', string[]>>;
  /**
   * Service-wide sandbox deny list (DATA, the service `.env`) and service ports (docs/adr/0014,
   * 0019) for the claude, codex and dsh workers. Credential directories under home are always
   * added.
   */
  sandbox?: SandboxPolicy;
  /** `service.json` → `runners.dsh` (docs/adr/0019). */
  dsh?: { allowUnsandboxed?: boolean };
}

/**
 * The registry returned by `createRunnerRegistry`. `capabilities(name)` returns the last probe
 * result: call `probeAll()` once at startup (and for `team doctor`); a runner that was never
 * probed reports `undefined` (the engine then treats it as available and the runner probes
 * lazily on first `run`).
 */
export interface ManagedRunnerRegistry extends RunnerRegistry {
  /** Probe every registered runner (in parallel) and cache the results. Never rejects. */
  probeAll(): Promise<RunnerCapabilities[]>;
  /** Probe one runner and cache the result. */
  probe(name: RunnerName): Promise<RunnerCapabilities | undefined>;
  /** In-process fake registered under `name` (only when created with `fake: true`). */
  fake(name: RunnerName): ScriptableFakeRunner | undefined;
}

/**
 * One scripted behaviour of the in-process fake (same shape as core's `FakeRunner` steps).
 * - `start`: `accepted` (default) calls `onStarted`; `unknown` resolves `start_unknown` without
 *   starting; `rejected` resolves an error (default `crash`) without starting.
 * - `hold`: wait until `release()` (or abort) before resolving.
 * - `onRun`: side effect before resolving, e.g. write files into `spec.cwd`.
 * - `files`: files (cwd-relative → content) written into `spec.cwd` before resolving.
 * - `result`: the RunResult (or a function of the spec); default = a valid receipt (impl runs
 *   list `files` in `files_changed`; review runs `pass`).
 */
export interface FakeRunStep {
  start?: 'accepted' | 'unknown' | 'rejected';
  hold?: boolean;
  delayMs?: number;
  files?: Record<string, string>;
  onRun?: (spec: RunSpec) => void | Promise<void>;
  result?: RunResult | ((spec: RunSpec) => RunResult);
}

export interface ScriptableFakeRunner extends Runner {
  readonly calls: RunSpec[];
  /** Behaviour used when the script queue is empty. */
  defaultStep: FakeRunStep;
  script(...steps: FakeRunStep[]): this;
  /** Dispatch ids of held runs. */
  held(): string[];
  release(dispatchId?: string, override?: RunResult): void;
  probeResult: RunnerCapabilities;
}
