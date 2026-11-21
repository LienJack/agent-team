import {
  ID_PREFIXES,
  type EventRecord,
  type IdKind,
  type OutboxItem,
  type RunnerCapabilities,
  type RunnerName,
} from '@agent-team/schema';
import type { Runner, RunnerRegistry } from '../ports/runner.js';
import type {
  CheckExecutor,
  CheckOutcome,
  Clock,
  EventPublisher,
  IdGen,
  LeaderNotifier,
  Notifier,
} from '../ports/services.js';

/** Clock that only moves when told to. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(start: string | Date = '2026-11-21T00:00:00.000Z') {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): Date {
    this.ms += ms;
    return this.now();
  }

  set(iso: string): void {
    this.ms = new Date(iso).getTime();
  }
}

/** Deterministic ids: `t_000001`, `r_000002`, … (one counter per kind). */
export class SequentialIdGen implements IdGen {
  private readonly counters = new Map<IdKind, number>();

  /** `start` offsets every counter (use a different one per simulated process restart). */
  constructor(private readonly start = 0) {}

  newId(kind: IdKind): string {
    const n = (this.counters.get(kind) ?? this.start) + 1;
    this.counters.set(kind, n);
    return `${ID_PREFIXES[kind]}${String(n).padStart(6, '0')}`;
  }
}

/** Registry holding whatever runners a test registers (default probe: available). */
export class InMemoryRunnerRegistry implements RunnerRegistry {
  private readonly runners = new Map<RunnerName, Runner>();
  private readonly caps = new Map<RunnerName, RunnerCapabilities>();

  register(runner: Runner, capabilities?: RunnerCapabilities): this {
    this.runners.set(runner.name, runner);
    if (capabilities) this.caps.set(runner.name, capabilities);
    return this;
  }

  setCapabilities(capabilities: RunnerCapabilities): void {
    this.caps.set(capabilities.runner, capabilities);
  }

  get(name: RunnerName): Runner | undefined {
    return this.runners.get(name);
  }

  names(): RunnerName[] {
    return [...this.runners.keys()];
  }

  capabilities(name: RunnerName): RunnerCapabilities | undefined {
    return this.caps.get(name);
  }
}

export type CheckScript =
  | Partial<CheckOutcome>
  | ((input: { name: string; cwd: string }) => Partial<CheckOutcome>);

/** Scripted machine checks: pass by default; `setResult(name, …)` changes one check. */
export class FakeCheckExecutor implements CheckExecutor {
  readonly calls: Array<{ cwd: string; name: string; cmd: string; logPath: string }> = [];
  private readonly scripts = new Map<string, CheckScript>();
  private failInfra = 0;

  setResult(name: string, script: CheckScript): this {
    this.scripts.set(name, script);
    return this;
  }

  /** The next `n` calls reject (infrastructure error → effect retry). */
  failNext(n = 1): this {
    this.failInfra += n;
    return this;
  }

  async run(input: {
    cwd: string;
    name: string;
    cmd: string;
    logPath: string;
    timeoutMs: number;
  }): Promise<CheckOutcome> {
    this.calls.push({ cwd: input.cwd, name: input.name, cmd: input.cmd, logPath: input.logPath });
    if (this.failInfra > 0) {
      this.failInfra--;
      throw new Error(`check runner unavailable (${input.name})`);
    }
    const script = this.scripts.get(input.name);
    const partial = typeof script === 'function' ? script(input) : (script ?? {});
    const passed = partial.passed ?? true;
    return {
      passed,
      exitCode: partial.exitCode ?? (passed ? 0 : 1),
      tail: partial.tail ?? (passed ? 'ok' : 'failed'),
      durationMs: partial.durationMs ?? 1,
    };
  }
}

/** Collects sent outbox items; `failNext(n)` makes deliveries throw. */
export class FakeNotifier implements Notifier {
  readonly sent: OutboxItem[] = [];
  private failures = 0;

  failNext(n = 1): this {
    this.failures += n;
    return this;
  }

  async send(item: OutboxItem): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('grokmsg unavailable');
    }
    this.sent.push(item);
  }
}

export class RecordingLeaderNotifier implements LeaderNotifier {
  readonly events: EventRecord[] = [];
  notify(events: readonly EventRecord[]): void {
    this.events.push(...events);
  }
}

export class RecordingPublisher implements EventPublisher {
  readonly events: EventRecord[] = [];
  publish(events: readonly EventRecord[]): void {
    this.events.push(...events);
  }
}
