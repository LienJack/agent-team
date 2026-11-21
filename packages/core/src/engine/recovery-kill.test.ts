import type { RunResult, RunSpec } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.js';
import { InMemoryStore } from '../memory/store.js';
import type { Runner, RunHooks } from '../ports/runner.js';
import type { FakeProcessControl } from '../testing/fakes.js';
import type { FakeGit } from '../testing/fake-git.js';
import { createTestEngine, editing } from '../testing/harness.js';
import { WORKER_UNCONFIRMED } from './start-unknown.js';

/** A crash: a new engine on the same store, worktrees and OS processes. */
function restart(store: InMemoryStore, git: FakeGit, processes: FakeProcessControl) {
  return createTestEngine({ store, git, processes, idOffset: 1000 });
}

async function crashWithLiveWorker(
  step: Parameters<FakeGit['touch']>[1] | undefined,
  spawn: {
    pid?: number;
    pidStartedAt?: string;
    launchOnly?: boolean;
  },
) {
  const store = new InMemoryStore();
  const before = createTestEngine({ store });
  before.runners.dsh.script({
    hold: true,
    ...(spawn.pid === undefined
      ? { launchOnly: true }
      : {
          spawn: {
            pid: spawn.pid,
            ...(spawn.pidStartedAt ? { pidStartedAt: spawn.pidStartedAt } : {}),
          },
        }),
  });
  const task = before.task();
  await before.engine.drain();
  if (step) before.git.touch(store.workspaces.findCurrentByTask(task.id)!.path, step);
  const run = store.runs.list({ task_id: task.id })[0]!;
  return { store, before, task, run };
}

describe('H2 recovery terminates orphaned worker groups before requeueing', () => {
  it('records the launch, pid and start time of the worker', async () => {
    const { run } = await crashWithLiveWorker(undefined, {
      pid: 4242,
      pidStartedAt: 'Sat Nov 21 10:00:00 2026',
    });
    expect(run).toMatchObject({
      state: 'running',
      pid: 4242,
      pid_started_at: 'Sat Nov 21 10:00:00 2026',
    });
    expect(run.launched_at).not.toBeNull();
  });

  it('kills the recorded group (same pid and start time), then requeues', async () => {
    const { store, before, task, run } = await crashWithLiveWorker(['src/feature/a.ts'], {
      pid: 4242,
      pidStartedAt: 'T-start',
    });
    before.processes.alive.set(4242, 'T-start');
    const after = restart(store, before.git, before.processes);
    const report = await after.engine.recover();
    expect(after.processes.calls).toEqual([{ pid: 4242, startedAt: 'T-start' }]);
    expect(after.processes.alive.has(4242)).toBe(false);
    expect(report.terminatedRuns).toEqual([run.id]);
    expect(report.requeuedTasks).toEqual([task.id]);
    expect(store.tasks.get(task.id)!.status).toBe('queued');
  });

  it('never signals a reused pid: another start time means the old group is gone', async () => {
    const { store, before, task } = await crashWithLiveWorker(undefined, {
      pid: 4242,
      pidStartedAt: 'T-start',
    });
    before.processes.alive.set(4242, 'T-someone-else');
    const after = restart(store, before.git, before.processes);
    await after.engine.recover();
    expect(after.processes.alive.get(4242)).toBe('T-someone-else'); // untouched
    expect(store.tasks.get(task.id)!.status).toBe('queued');
  });

  it('blocks the task and asks a human when the worker cannot be confirmed dead', async () => {
    const { store, before, task, run } = await crashWithLiveWorker(['src/feature/a.ts'], {
      pid: 4242,
      pidStartedAt: 'T-start',
    });
    before.processes.alive.set(4242, null); // group members left without their leader
    const after = restart(store, before.git, before.processes);
    const report = await after.engine.recover();
    expect(report.blockedTasks).toEqual([task.id]);
    expect(report.requeuedTasks).toEqual([]);
    expect(store.runs.get(run.id)!.error).toContain(WORKER_UNCONFIRMED);
    expect(store.tasks.get(task.id)!.status).toBe('blocked');
    expect(store.attention.list({ task_id: task.id, statuses: ['open'] })).toHaveLength(1);
    await after.engine.runUntilIdle();
    expect(after.runners.dsh.calls).toHaveLength(0); // no second worker in that worktree
    expect(() => after.engine.retryTask(task.id, { kind: 'leader' })).toThrow(ForbiddenError);
    after.runners.dsh.script(editing(after.git, ['src/feature/b.ts']));
    expect(after.engine.retryTask(task.id).status).toBe('queued'); // the human checked
    await after.engine.runUntilIdle();
    expect(after.runners.dsh.calls).toHaveLength(1);
  });

  it('blocks when the process was launched but its pid never reached the database', async () => {
    const { store, before, task } = await crashWithLiveWorker(undefined, { launchOnly: true });
    expect(store.runs.list({ task_id: task.id })[0]!.pid).toBeNull();
    const after = restart(store, before.git, before.processes);
    const report = await after.engine.recover();
    expect(report.blockedTasks).toEqual([task.id]);
    expect(store.tasks.get(task.id)!.status).toBe('blocked');
  });

  it('without a process control port a recorded worker is never assumed dead', async () => {
    const { store, before, task } = await crashWithLiveWorker(undefined, {
      pid: 4242,
      pidStartedAt: 'T-start',
    });
    const after = createTestEngine({ store, git: before.git, idOffset: 1000 });
    (after.engine.ctx.deps as { processes?: unknown }).processes = undefined;
    await after.engine.recover();
    expect(store.tasks.get(task.id)!.status).toBe('blocked');
  });
});

/** Ignores abort until released: a worker whose process takes a while to die. */
class StubbornRunner implements Runner {
  readonly name = 'codex' as const;
  readonly calls: RunSpec[] = [];
  private releases: Array<() => void> = [];
  async probe() {
    return {
      runner: 'codex' as const,
      available: true,
      credentials: 'not_required' as const,
      supports: { jsonSchema: true, resume: false, quota: false, effort: true, readOnly: true },
      flags: [],
      problems: [],
    };
  }
  async run(spec: RunSpec, _signal: AbortSignal, hooks?: RunHooks): Promise<RunResult> {
    this.calls.push(spec);
    hooks?.onStarted?.({});
    await new Promise<void>((resolve) => this.releases.push(resolve));
    return { error: { kind: 'cancelled', message: 'stopped late' } };
  }
  release(): void {
    for (const r of this.releases.splice(0)) r();
  }
}

describe('H2 a stopped run whose kill had not finished before the crash', () => {
  async function stoppedReviewer(alive: string | null) {
    const store = new InMemoryStore();
    const before = createTestEngine({ store });
    before.runners.dsh.script(editing(before.git, ['src/feature/a.ts']), { hold: true });
    before.runners.codex.script({ hold: true, spawn: { pid: 6161, pidStartedAt: 'T-rev' } });
    const task = before.task();
    await before.engine.drain();
    expect(store.tasks.get(task.id)!.status).toBe('review');
    before.engine.rejectTask(task.id, 'redo'); // the reviewer is stopped; its group may linger
    await before.engine.drain();
    const review = store.runs.list({ task_id: task.id }).find((r) => r.kind === 'review')!;
    expect(review).toMatchObject({ state: 'stopped', pid: 6161 });
    before.processes.alive.set(6161, alive);
    const after = restart(store, before.git, before.processes);
    const report = await after.engine.recover();
    return { store, after, task, report };
  }

  it('is terminated by recovery when it is still the same process', async () => {
    const { after, store, task } = await stoppedReviewer('T-rev');
    expect(after.processes.alive.has(6161)).toBe(false);
    expect(store.tasks.get(task.id)!.status).toBe('queued');
  });

  it('blocks the task when it cannot be confirmed dead (human retry only)', async () => {
    const { store, task, report, after } = await stoppedReviewer(null);
    expect(report.blockedTasks).toContain(task.id);
    expect(store.tasks.get(task.id)!.status).toBe('blocked');
    expect(() => after.engine.retryTask(task.id, { kind: 'leader' })).toThrow(ForbiddenError);
  });
});

describe('H2 no second worker while the previous one may be alive', () => {
  it('a stopped run whose process has not exited yet holds the task back', async () => {
    const h = createTestEngine();
    const stubborn = new StubbornRunner();
    h.registry.register(stubborn);
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.drain();
    expect(h.get(task.id).status).toBe('review');
    expect(stubborn.calls).toHaveLength(1);
    h.engine.rejectTask(task.id, 'redo it');
    await h.engine.drain();
    expect(h.get(task.id)).toMatchObject({ status: 'queued', current_run_id: null });
    expect(h.runners.dsh.calls).toHaveLength(1); // the fix waits for the reviewer process
    stubborn.release();
    h.runners.dsh.script(editing(h.git, ['src/feature/b.ts']));
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await h.engine.drain();
    expect(h.runners.dsh.calls).toHaveLength(2);
  });

  it('graceful shutdown aborts a running machine check instead of waiting for it', async () => {
    const h = createTestEngine();
    h.checks.setResult('test', 'hang');
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    for (let i = 0; i < 50 && h.checks.calls.length === 0; i++) {
      void h.engine.tick();
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
    expect(h.get(task.id).status).toBe('verifying');
    // without the abort, the hanging check would keep shutdown() waiting forever
    await h.engine.shutdown();
    expect(h.git.calls.some((c) => c.method === 'commitFiles')).toBe(false);
    // the verification is kept for the next start
    expect(h.store.effects.list().some((e) => e.kind === 'run.verify')).toBe(true);
    expect(h.get(task.id).status).toBe('verifying');
  });
});
