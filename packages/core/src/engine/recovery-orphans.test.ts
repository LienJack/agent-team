import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../memory/store.js';
import { createTestEngine } from '../testing/harness.js';

// docs/adr/0022 §4 in core: after the recorded group, recovery asks ProcessControl to sweep what
// the dead run left outside its group (proof of ownership is the adapter's job; real processes
// in packages/runners). Proven survivors block the task like an unconfirmed worker; a platform
// without the information keeps the group-only behaviour.

async function crashed(pid: number) {
  const store = new InMemoryStore();
  const before = createTestEngine({ store });
  before.runners.dsh.script({ hold: true, spawn: { pid, pidStartedAt: 'T-start' } });
  const task = before.task();
  await before.engine.drain();
  const run = store.runs.list({ task_id: task.id })[0]!;
  const after = createTestEngine({
    store,
    git: before.git,
    processes: before.processes,
    idOffset: 1000,
  });
  return { store, before, after, task, run };
}

describe('recovery sweeps leftovers outside the worker group', () => {
  it("passes the run's own paths and launch time; proven leftovers gone → requeued", async () => {
    const { store, before, after, task, run } = await crashed(4242);
    before.processes.alive.set(4242, 'T-start');
    before.processes.sweep = { supported: true, terminated: [5001, 5002], survivors: [] };
    const report = await after.engine.recover();
    const ws = store.workspaces.findCurrentByTask(task.id)!;
    expect(after.processes.sweeps).toEqual([
      { paths: [run.log_dir, ws.path], since: run.launched_at },
    ]);
    expect(report.terminatedRuns).toEqual([run.id]);
    expect(store.tasks.get(task.id)!.status).toBe('queued');
  });

  it('a proven leftover that will not die blocks the task (only a human retries)', async () => {
    const { store, before, after, task } = await crashed(4242);
    before.processes.alive.set(4242, 'T-start');
    before.processes.sweep = { supported: true, terminated: [], survivors: [5001] };
    const report = await after.engine.recover();
    expect(report.blockedTasks).toEqual([task.id]);
    expect(store.tasks.get(task.id)!.status).toBe('blocked');
    const items = store.attention.list({ task_id: task.id, statuses: ['open'] });
    expect(items.map((a) => a.topic)).toEqual(['worker_unconfirmed']);
  });

  it('a leaderless group whose members the sweep proved and removed is gone: requeued', async () => {
    const { store, before, after, task } = await crashed(4242);
    before.processes.alive.set(4242, null); // members without their leader
    before.processes.sweptGroups.add(4242);
    before.processes.sweep = { supported: true, terminated: [5003], survivors: [] };
    await after.engine.recover();
    expect(after.processes.calls).toHaveLength(2); // looked at the group again
    expect(store.tasks.get(task.id)!.status).toBe('queued');
  });

  it('where nothing can be examined, the group-only behaviour stays (members left → blocked)', async () => {
    const { store, before, after, task } = await crashed(4242);
    before.processes.alive.set(4242, null);
    // default sweep: { supported: false }
    await after.engine.recover();
    expect(after.processes.sweeps).toHaveLength(1);
    expect(store.tasks.get(task.id)!.status).toBe('blocked');
  });
});
