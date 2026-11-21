import type {
  ImplReceipt,
  ReviewReceipt,
  RunnerCapabilities,
  RunnerName,
  RunResult,
  RunSpec,
} from '@agent-team/schema';
import type { Runner, RunHooks } from '../ports/runner.js';

/** Receipt helpers bound to a spec's dispatch id. */
export function implReceipt(spec: RunSpec, overrides: Partial<ImplReceipt> = {}): ImplReceipt {
  return {
    dispatch_id: spec.dispatchId,
    status: 'done',
    summary: '完成',
    files_changed: [],
    checks: [],
    needs_leader: '',
    ...overrides,
  };
}

export function reviewReceipt(
  spec: RunSpec,
  overrides: Partial<ReviewReceipt> = {},
): ReviewReceipt {
  return {
    dispatch_id: spec.dispatchId,
    verdict: 'pass',
    summary: '沒問題',
    findings: [],
    ...overrides,
  };
}

/** Whether a spec is for a review run (read-only). */
export const isReviewSpec = (spec: RunSpec) => !spec.writable;

/**
 * One scripted behaviour of `FakeRunner.run`.
 * - `start`: `accepted` (default) calls onStarted; `unknown` resolves `start_unknown` without
 *   starting; `rejected` resolves an error (default `crash`) without starting.
 * - `hold`: wait until `release()` (or abort) before resolving.
 * - `onRun`: side effect before resolving (e.g. touch files in the FakeGit worktree).
 * - `result`: the RunResult (or a function of the spec); default = a passing receipt.
 */
export interface FakeStep {
  start?: 'accepted' | 'unknown' | 'rejected';
  hold?: boolean;
  onRun?: (spec: RunSpec) => void | Promise<void>;
  result?: RunResult | ((spec: RunSpec) => RunResult);
  pid?: number;
}

interface Held {
  spec: RunSpec;
  release: (override?: RunResult) => void;
}

function defaultResult(spec: RunSpec): RunResult {
  return {
    final: isReviewSpec(spec) ? reviewReceipt(spec) : implReceipt(spec),
    usage: { input_tokens: 100, output_tokens: 50 },
    costUsd: 0.01,
  };
}

/**
 * Scriptable in-memory runner for core tests. Every call is recorded in `calls`. Queue
 * behaviours with `script(...)`; when the queue is empty `defaultStep` is used.
 */
export class FakeRunner implements Runner {
  readonly calls: RunSpec[] = [];
  private readonly queue: FakeStep[] = [];
  private readonly heldRuns = new Map<string, Held>();
  defaultStep: FakeStep = {};
  probeResult: RunnerCapabilities;

  constructor(readonly name: RunnerName = 'fake') {
    this.probeResult = {
      runner: name,
      available: true,
      version: 'fake-1',
      credentials: 'not_required',
      supports: { jsonSchema: true, resume: false, quota: false, effort: true, readOnly: true },
      flags: [],
      problems: [],
    };
  }

  script(...steps: FakeStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  /** Dispatch ids of runs currently held. */
  held(): string[] {
    return [...this.heldRuns.keys()];
  }

  /** Finish a held run (optionally with a different result). */
  release(dispatchId?: string, override?: RunResult): void {
    const id = dispatchId ?? this.held()[0];
    const held = id === undefined ? undefined : this.heldRuns.get(id);
    if (!held) throw new Error(`no held run ${dispatchId ?? ''}`);
    this.heldRuns.delete(id!);
    held.release(override);
  }

  async probe(): Promise<RunnerCapabilities> {
    return this.probeResult;
  }

  async run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunResult> {
    this.calls.push(spec);
    const step = this.queue.shift() ?? this.defaultStep;
    const start = step.start ?? 'accepted';
    if (start === 'unknown') {
      return { error: { kind: 'start_unknown', message: 'spawn did not report' } };
    }
    if (start === 'rejected') {
      const result = typeof step.result === 'function' ? step.result(spec) : step.result;
      return result?.error ? result : { error: { kind: 'crash', message: 'spawn failed' } };
    }
    hooks?.onStarted?.(step.pid === undefined ? {} : { pid: step.pid });

    let override: RunResult | undefined;
    if (step.hold) {
      override = await new Promise<RunResult | undefined>((resolve) => {
        const onAbort = () => {
          this.heldRuns.delete(spec.dispatchId);
          resolve({ error: { kind: 'cancelled', message: 'aborted' } });
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        this.heldRuns.set(spec.dispatchId, {
          spec,
          release: (r) => {
            signal.removeEventListener('abort', onAbort);
            resolve(r);
          },
        });
      });
      if (override?.error?.kind === 'cancelled') return override;
    }
    if (signal.aborted) return { error: { kind: 'cancelled', message: 'aborted' } };
    await step.onRun?.(spec);
    if (override) return override;
    if (step.result === undefined) return defaultResult(spec);
    return typeof step.result === 'function' ? step.result(spec) : step.result;
  }
}
