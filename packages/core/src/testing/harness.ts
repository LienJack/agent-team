import type { EventType, Project, RunnerName, Task, TaskCreateRequest } from '@agent-team/schema';
import { Engine } from '../engine/engine.js';
import type { EngineConfig } from '../engine/context.js';
import { InMemoryStore } from '../memory/store.js';
import type { Store } from '../ports/repositories.js';
import { FakeGit } from './fake-git.js';
import { FakeRunner, type FakeStep } from './fake-runner.js';
import {
  FakeCheckExecutor,
  FakeNotifier,
  FakeProcessControl,
  InMemoryRunnerRegistry,
  ManualClock,
  RecordingLeaderNotifier,
  RecordingPublisher,
  SequentialIdGen,
} from './fakes.js';
import { testEngineConfig } from './fixtures.js';

export interface TestEngine {
  engine: Engine;
  store: Store;
  clock: ManualClock;
  git: FakeGit;
  checks: FakeCheckExecutor;
  notifier: FakeNotifier;
  leader: RecordingLeaderNotifier;
  publisher: RecordingPublisher;
  registry: InMemoryRunnerRegistry;
  processes: FakeProcessControl;
  /** One fake per runner name used by the test models config. */
  runners: Record<'claude' | 'codex' | 'dsh', FakeRunner>;
  config: EngineConfig;
  /** Create the `demo` project (checks: one `test` check). */
  project(overrides?: Partial<Parameters<Engine['createProject']>[0]>): Project;
  /** Create a queued task in the demo project. */
  task(overrides?: Partial<TaskCreateRequest>): Task;
  /** Reload a task from the store. */
  get(taskId: string): Task;
  /** Types of events written so far (optionally for one task). */
  eventTypes(taskId?: string): EventType[];
  /** Fake for a runner name. */
  runner(name: RunnerName): FakeRunner;
}

export interface TestEngineOptions {
  config?: Partial<EngineConfig>;
  store?: Store;
  /** Default step for every fake runner. */
  defaultStep?: FakeStep;
  /** Offset for sequential ids (a "restarted" engine on the same store needs fresh ids). */
  idOffset?: number;
  /** Share the worktrees of another engine's FakeGit (a restart keeps the filesystem). */
  git?: FakeGit;
  /** Share the processes of another engine (a restart keeps the OS processes). */
  processes?: FakeProcessControl;
}

/**
 * An engine on the in-memory store with fakes for every port. Runs by default produce a valid
 * receipt for their dispatch id and touch nothing — use `onRun` with `git.touch` to simulate
 * edits.
 */
export function createTestEngine(options: TestEngineOptions = {}): TestEngine {
  const store = options.store ?? new InMemoryStore();
  const clock = new ManualClock();
  const git = options.git ?? new FakeGit();
  const checks = new FakeCheckExecutor();
  const notifier = new FakeNotifier();
  const leader = new RecordingLeaderNotifier();
  const publisher = new RecordingPublisher();
  const registry = new InMemoryRunnerRegistry();
  const processes = options.processes ?? new FakeProcessControl();
  const runners = {
    claude: new FakeRunner('claude'),
    codex: new FakeRunner('codex'),
    dsh: new FakeRunner('dsh'),
  };
  for (const r of Object.values(runners)) {
    if (options.defaultStep) r.defaultStep = options.defaultStep;
    // probed: the engine reads `supports.webSearch` for research runs (spec §17)
    registry.register(r, r.probeResult);
  }
  const config = testEngineConfig(options.config);
  const engine = new Engine({
    store,
    runners: registry,
    git,
    checks,
    clock,
    ids: new SequentialIdGen(options.idOffset ?? 0),
    config,
    notifier,
    leader,
    publisher,
    processes,
  });
  let projectId: string | undefined;
  const harness: TestEngine = {
    engine,
    store,
    clock,
    git,
    checks,
    notifier,
    leader,
    publisher,
    registry,
    processes,
    runners,
    config,
    project(overrides = {}) {
      const p = engine.createProject({
        name: 'demo',
        repo_path: '/repos/demo',
        base_branch: 'main',
        checks: [{ name: 'test', cmd: 'pnpm test' }],
        ...overrides,
      });
      projectId ??= p.id;
      return p;
    },
    task(overrides = {}) {
      projectId ??= harness.project().id;
      return engine.createTask(
        {
          project_id: projectId,
          title: '加一個功能',
          tier: 'C',
          ticket_md: '# 派工單\n做一件事',
          owned_paths: ['src/feature/'],
          queue: true,
          ...overrides,
        },
        { kind: 'leader' },
      );
    },
    get(taskId) {
      const t = store.tasks.get(taskId);
      if (!t) throw new Error(`task ${taskId} missing`);
      return t;
    },
    eventTypes(taskId) {
      return store.events
        .listAfter(0)
        .filter((e) => taskId === undefined || e.task_id === taskId)
        .map((e) => e.type);
    },
    runner(name) {
      const r = registry.get(name);
      if (!(r instanceof FakeRunner)) throw new Error(`no fake runner ${name}`);
      return r;
    },
  };
  return harness;
}

/** A FakeStep that edits `files` in the run's worktree (cwd) before answering. */
export function editing(git: FakeGit, files: string[], extra: FakeStep = {}): FakeStep {
  return {
    ...extra,
    onRun: async (spec) => {
      git.touch(spec.cwd, files);
      await extra.onRun?.(spec);
    },
  };
}
