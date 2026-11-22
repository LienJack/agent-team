import {
  isLiveRunState,
  type AnswerVia,
  type Attention,
  type AttentionCreateRequest,
  type Message,
  type MessageStatus,
  type Project,
  type ProjectCreateRequest,
  type ResearchCreateRequest,
  type RunnerStatus,
  type Task,
  type TaskCreateRequest,
} from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import {
  answer,
  approveTask,
  cancelTask,
  createAttention,
  createProject,
  createTask,
  queueTask,
  reassignTask,
  rejectTask,
  retryTask,
  type Actor,
} from './commands.js';
import { EngineContext, type EngineDeps } from './context.js';
import { dispatchPlanned, type DispatchReport } from './dispatch.js';
import { DRIFT_OPTIONS, openDriftItem } from './drift.js';
import { EffectExecutor } from './effects.js';
import { recordMessage, setMessageStatus, type RecordMessageInput } from './messages.js';
import { createResearch } from './research.js';
import { blockTask } from './outcomes.js';
import { abandonLiveRuns, recover, sweepWorkspaces, type RecoveryReport } from './recovery.js';
import { isHalfOpen, resolveRole, type QuotaState } from './resolve-role.js';
import { runnerStatuses } from './runner-health.js';
import { planDispatch, PATH_HOLDING_STATUSES, type Deferred } from './scheduler.js';
import { trackWaiting, type WaitingEntry } from './waiting.js';

export interface TickReport {
  dispatched: DispatchReport[];
  deferred: Deferred[];
  blocked: Array<{ task_id: string; reason: string }>;
  effectsStarted: number;
  cleanupQueued: number;
}

const HUMAN: Actor = { kind: 'human' };

/**
 * The single writer of task state (spec §8). Driven by `tick()` — called by the server after
 * commands and on a patrol interval (`engine.tick_ms`) — and by run completions. Core has no
 * timers: everything time-based compares `Clock.now()` with stored timestamps.
 */
export class Engine {
  readonly ctx: EngineContext;
  private readonly effects: EffectExecutor;
  private ticking: Promise<TickReport> | undefined;
  private wakeRequested = false;
  private suspended = false;

  constructor(deps: EngineDeps) {
    this.ctx = new EngineContext(deps);
    this.effects = new EffectExecutor(this.ctx);
    this.ctx.onCommit = () => this.wake();
  }

  /**
   * Startup recovery; call once before the first tick. Automatic wake-ups are suspended while it
   * runs so no dispatch can race the orphan-worktree scan.
   */
  async recover(): Promise<RecoveryReport> {
    this.suspended = true;
    try {
      return await recover(this.ctx);
    } finally {
      this.suspended = false;
      this.wake();
    }
  }

  /** Why a waiting task is not dispatched (board cards; null when not waiting/unknown). */
  waitingOf(taskId: string): WaitingEntry | null {
    return this.ctx.waiting.get(taskId)?.shown ?? null;
  }

  /** Current per-runner health/availability (the `/quota` view). */
  runnerStatuses(): RunnerStatus[] {
    return runnerStatuses(this.ctx.store.kv, this.ctx.deps.runners, this.ctx.now());
  }

  quotaState(): QuotaState {
    return Object.fromEntries(this.runnerStatuses().map((s) => [s.runner, s]));
  }

  /**
   * One scheduling pass: cleanup sweep, dispatch what fits, start due effects. Concurrent calls
   * share the pass in progress.
   */
  tick(): Promise<TickReport> {
    if (this.ctx.stopping) {
      return Promise.resolve({
        dispatched: [],
        deferred: [],
        blocked: [],
        effectsStarted: 0,
        cleanupQueued: 0,
      });
    }
    this.ticking ??= this.doTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** Request a tick soon without awaiting it (coalesced). */
  wake(): void {
    if (this.wakeRequested || this.suspended || this.ctx.stopping) return;
    this.wakeRequested = true;
    void Promise.resolve().then(() => {
      this.wakeRequested = false;
      this.ctx.track(this.tick());
    });
  }

  private async doTick(): Promise<TickReport> {
    const { ctx } = this;
    const cleanupQueued = sweepWorkspaces(ctx);
    const now = ctx.now();
    const quota = this.quotaState();
    const tasks = ctx.store.tasks.list({ statuses: ['queued', ...PATH_HOLDING_STATUSES] });
    const liveRuns = ctx.store.runs.list({ states: ['starting', 'running'] });
    // a half-open circuit gets exactly one trial: a live run (or a dispatch being prepared) on
    // that runner is the trial in flight; a trial planned in this pass takes it too (L9e)
    const trialBusy = new Set<string>();
    const halfOpen = (runner: string) => isHalfOpen(quota[runner], now);
    for (const run of liveRuns) if (halfOpen(run.runner)) trialBusy.add(run.runner);
    for (const runner of ctx.dispatchingRunners.values()) {
      if (halfOpen(runner)) trialBusy.add(runner);
    }
    const plan = planDispatch({
      tasks,
      liveRuns,
      dispatching: ctx.dispatching,
      dispatchingPaths: [...ctx.dispatching.keys()].map(
        (id) => ctx.store.tasks.get(id)?.owned_paths ?? [],
      ),
      workerTasks: new Set(ctx.workerTasks.keys()),
      ignoreCaseOf: (projectId) => ctx.caseInsensitive.get(projectId) ?? true,
      humanPriority: ctx.humanPriority,
      models: ctx.config.models,
      engine: ctx.config.engine,
      now,
      resolve: (role, excludeAliases, web) => {
        const resolved = resolveRole(role, quota, {
          models: ctx.config.models,
          now,
          excludeAliases,
          trialBusy,
          // research runs only go to runners whose probe says they can run web-only (spec §17)
          ...(web
            ? { webSearch: (r) => ctx.deps.runners.capabilities(r)?.supports.webSearch === true }
            : {}),
        });
        if (resolved.ok && halfOpen(resolved.runner)) trialBusy.add(resolved.runner);
        return resolved;
      },
      implAliasOf: (taskId) =>
        ctx.store.runs
          .list({ task_id: taskId })
          .findLast((r) => r.kind === 'impl' || r.kind === 'fix')?.model_alias,
    });

    const blocked: TickReport['blocked'] = [];
    for (const { task, reason } of plan.invalid) {
      ctx.transact((tx) => {
        const current = tx.r.tasks.get(task.id);
        if (current && current.version === task.version) {
          blockTask(ctx, tx, current, `無法派工：${reason}`);
          blocked.push({ task_id: task.id, reason });
        }
      });
    }

    const dispatched: DispatchReport[] = [];
    for (const planned of plan.dispatch) {
      let report: DispatchReport;
      try {
        report = await dispatchPlanned(ctx, planned);
      } catch (err) {
        // an unexpected error must not stop the rest of the pass; the task stays waiting
        ctx.logger.error('dispatch failed', { task_id: planned.task.id, error: errorMessage(err) });
        report = {
          task_id: planned.task.id,
          outcome: 'deferred',
          reason: `error: ${errorMessage(err)}`,
        };
      }
      dispatched.push(report);
      if (report.outcome === 'deferred' && report.reason === 'base_drift_blocked') {
        blocked.push({ task_id: planned.task.id, reason: 'base_drift' });
      }
    }
    trackWaiting(ctx, plan.deferred, blocked);
    const effectsStarted = this.effects.runDue();
    return { dispatched, deferred: plan.deferred, blocked, effectsStarted, cleanupQueued };
  }

  /** Await effect executions and dispatches in flight (not run completions). */
  async drain(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (this.ctx.work.size === 0) {
        const report = await this.tick();
        if (
          report.effectsStarted === 0 &&
          report.dispatched.length === 0 &&
          this.ctx.work.size === 0
        ) {
          return;
        }
      }
      await Promise.allSettled(this.ctx.work);
    }
    throw new Error(`engine did not settle within ${maxRounds} rounds`);
  }

  /** `drain` plus waiting for in-flight runs to finish, until nothing is left (tests). */
  async runUntilIdle(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await this.drain(maxRounds);
      if (this.ctx.runWork.size === 0 && this.ctx.work.size === 0) {
        const report = await this.tick();
        if (
          report.effectsStarted === 0 &&
          report.dispatched.length === 0 &&
          this.ctx.work.size === 0
        ) {
          return;
        }
        continue;
      }
      await Promise.allSettled([...this.ctx.runWork, ...this.ctx.work]);
    }
    throw new Error(`engine did not become idle within ${maxRounds} rounds`);
  }

  /**
   * Stop for good: no more ticks or wake-ups; abort the runs started by this process (each runner
   * terminates its worker's whole process group before it resolves) and wait for in-flight work.
   * Their results are not applied; instead every live run is marked `abandoned` and its task
   * requeued with a recovery note (attempts unchanged), so the next start has nothing to repair.
   * A crash skips this step and `recover()` does the same on the next start.
   */
  async shutdown(): Promise<{ abandonedRuns: string[] }> {
    this.ctx.stopping = true;
    // long verification steps (machine checks) stop now instead of running to their timeout
    this.ctx.shutdownController.abort('service shutdown');
    // A pass in progress may still finish a dispatch (it starts no effects any more: `runDue`
    // is off) and a run.start already executing may still have spawned: abort and settle until
    // nothing is left, so no worker outlives the service and no run is created after the marking.
    for (let round = 0; round < 50; round++) {
      for (const controller of this.ctx.inflight.values()) controller.abort('service shutdown');
      const pending = [
        ...this.ctx.work,
        ...this.ctx.runWork,
        ...(this.ticking ? [this.ticking] : []),
      ];
      if (pending.length === 0 && this.ctx.inflight.size === 0) break;
      await Promise.allSettled(pending);
    }
    try {
      return this.ctx.transact((tx) => ({
        abandonedRuns: abandonLiveRuns(this.ctx, tx, 'shutdown').abandonedRuns,
      }));
    } catch (err) {
      // the store may already be unusable; recovery on the next start covers it
      this.ctx.logger.error('marking runs at shutdown failed', { error: errorMessage(err) });
      return { abandonedRuns: [] };
    }
  }

  // ------------------------------------------------------------ commands
  // Each command is one transaction; committing wakes the engine (no explicit tick needed).

  createProject(input: ProjectCreateRequest, actor: Actor = HUMAN): Project {
    return createProject(this.ctx, input, actor);
  }

  createTask(input: TaskCreateRequest, actor: Actor = HUMAN): Task {
    return createTask(this.ctx, input, actor);
  }

  /** A research task (spec §17); 409 while `research.mode` is `off`. */
  createResearch(input: ResearchCreateRequest, actor: Actor = HUMAN): Task {
    return createResearch(this.ctx, input, actor);
  }

  queueTask(id: string, actor: Actor = HUMAN): Task {
    return queueTask(this.ctx, id, actor);
  }

  cancelTask(id: string, reason?: string): Task {
    return cancelTask(this.ctx, id, reason);
  }

  retryTask(id: string, actor: Actor = HUMAN): Task {
    return retryTask(this.ctx, id, actor);
  }

  approveTask(id: string, reason?: string, actor: Actor = HUMAN): Task {
    return approveTask(this.ctx, id, reason, actor);
  }

  rejectTask(id: string, note: string, actor: Actor = HUMAN): Task {
    return rejectTask(this.ctx, id, note, actor);
  }

  reassignTask(id: string, role: string, actor: Actor = HUMAN): Task {
    return reassignTask(this.ctx, id, role, actor);
  }

  openAttention(input: AttentionCreateRequest): Attention {
    return createAttention(this.ctx, input);
  }

  answerAttention(id: string, text: string, via: AnswerVia, actor: Actor = HUMAN): Attention {
    return answer(this.ctx, id, text, via, actor);
  }

  /** Base drift: discard the worktree, rebuild it on the new base, restart (human; M5). */
  rebuildWorkspace(taskId: string, via: AnswerVia = 'cli', actor: Actor = HUMAN): Attention {
    const item = this.ctx.transact((tx) => openDriftItem(tx, taskId));
    return answer(this.ctx, item.id, DRIFT_OPTIONS[0], via, actor);
  }

  /** Base drift: accept the new base tip and continue on the old base (human; M5). */
  acceptNewBase(taskId: string, via: AnswerVia = 'cli', actor: Actor = HUMAN): Attention {
    const item = this.ctx.transact((tx) => openDriftItem(tx, taskId));
    return answer(this.ctx, item.id, DRIFT_OPTIONS[1], via, actor);
  }

  recordMessage(input: RecordMessageInput): { message: Message; duplicate: boolean } {
    return recordMessage(this.ctx, input);
  }

  setMessageStatus(id: string, status: MessageStatus): Message {
    return setMessageStatus(this.ctx, id, status);
  }

  /**
   * A live run's log grew to `offset` bytes (the server watches the files; core does no IO):
   * one `run.log_advanced` event so viewers refresh the log tail. Not a state change, so the
   * scheduler is not woken. False when the run is unknown or no longer live.
   */
  recordRunLog(runId: string, offset: number): boolean {
    return this.ctx.transact((tx) => {
      const run = tx.r.runs.get(runId);
      if (!run || !isLiveRunState(run.state)) return false;
      tx.emit('run.log_advanced', { offset }, { run_id: run.id });
      tx.dirty = false;
      return true;
    });
  }
}
