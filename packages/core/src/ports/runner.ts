import type {
  RunnerCapabilities,
  RunnerName,
  RunQuota,
  RunResult,
  RunSpec,
  RunStartedInfo,
} from '@agent-team/schema';

/** Callbacks a runner fires during `run`. */
export interface RunHooks {
  /**
   * Call exactly once, as soon as the agent process is known to be running (spawned and alive /
   * thread created). The engine uses it to tell `accepted` from `rejected` dispatches: a run
   * that resolves without calling it is treated as never started (unless it succeeded).
   */
  onStarted?(info: RunStartedInfo): void;
}

/**
 * One worker backend (spec §7): claude, codex, dsh or the scripted fake. Implemented in
 * `packages/runners`.
 *
 * Contract:
 * - `run` resolves (never rejects) with a `RunResult`; failures go in `result.error`.
 * - Report `start_unknown` when the agent may or may not have started (e.g. spawn hung); the
 *   engine then never resends automatically. Any other error before `onStarted` = not started.
 * - When `signal` aborts, terminate the whole process group and resolve with `cancelled`.
 * - Enforce `spec.timeoutMs` yourself and resolve with `timeout`.
 * - Arguments as arrays (no shell); stdin closed; logs to `spec.logDir` with secrets masked.
 */
export interface Runner {
  readonly name: RunnerName;
  /** Check binary, version, supported flags and credential readiness (never values). */
  probe(): Promise<RunnerCapabilities>;
  run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunResult>;
}

/** Optional capability: the runner can continue a previous session via `spec.resumeRef`. */
export interface Resumable {
  readonly resumable: true;
}

/** Optional capability: the runner can report subscription quota without running a task. */
export interface QuotaReporting {
  readQuota(): Promise<RunQuota | undefined>;
}

export function isResumable(runner: Runner): runner is Runner & Resumable {
  return (runner as Partial<Resumable>).resumable === true;
}

export function isQuotaReporting(runner: Runner): runner is Runner & QuotaReporting {
  return typeof (runner as Partial<QuotaReporting>).readQuota === 'function';
}

/**
 * Looks up runners by name. The server registers real runners at startup and caches their
 * `probe()` results; tests register fakes.
 */
export interface RunnerRegistry {
  get(name: RunnerName): Runner | undefined;
  /** Registered runner names. */
  names(): RunnerName[];
  /**
   * Last probe result, or undefined when never probed. The engine treats a runner as unavailable
   * only when a probe exists and says `available: false`.
   */
  capabilities(name: RunnerName): RunnerCapabilities | undefined;
}
