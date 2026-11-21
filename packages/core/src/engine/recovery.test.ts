import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../memory/store.js';
import type { FakeGit } from '../testing/fake-git.js';
import { sampleRun, sampleWorkspace } from '../testing/fixtures.js';
import { createTestEngine, editing } from '../testing/harness.js';

/** Simulate a crash: a new engine on the same store (in-memory runs/controllers are lost). */
function restart(store: InMemoryStore, git?: FakeGit) {
  return createTestEngine({ store, idOffset: 1000, ...(git ? { git } : {}) });
}

describe('§14 啟動復原 — startup recovery', () => {
  it('abandons live runs, requeues impl tasks with a recovery note used by the next prompt', async () => {
    const store = new InMemoryStore();
    const before = createTestEngine({ store });
    before.runners.dsh.script({ hold: true });
    const task = before.task();
    await before.engine.drain();
    const run = store.runs.list({ task_id: task.id })[0]!;
    expect(run.state).toBe('running');

    const after = restart(store);
    after.git.worktrees.set(
      store.workspaces.findCurrentByTask(task.id)!.path,
      before.git.worktrees.get(store.workspaces.findCurrentByTask(task.id)!.path)!,
    );
    const report = await after.engine.recover();
    expect(report.abandonedRuns).toEqual([run.id]);
    expect(report.requeuedTasks).toEqual([task.id]);
    expect(store.runs.get(run.id)).toMatchObject({ state: 'abandoned' });
    const requeued = store.tasks.get(task.id)!;
    expect(requeued).toMatchObject({ status: 'queued', current_run_id: null, attempts: 0 });
    expect(requeued.recovery_note).toContain(run.dispatch_id);
    const recovered = store.events.listAfter(0).find((e) => e.type === 'recovery.completed');
    expect(recovered?.data).toMatchObject({ abandoned_runs: [run.id], requeued_tasks: [task.id] });

    after.runners.dsh.script(editing(after.git, ['src/feature/a.ts']));
    await after.engine.runUntilIdle();
    const prompt = after.runners.dsh.calls[0]!.prompt;
    expect(prompt).toContain('## 復原說明');
    expect(prompt).toContain(run.id);
    expect(store.tasks.get(task.id)).toMatchObject({ status: 'done', recovery_note: null });
    // the old held run never resolves; the new process does not resend it
    expect(before.runners.dsh.calls).toHaveLength(1);
  });

  it('shutdown aborts live runs without finalizing them; the next start recovers them', async () => {
    const store = new InMemoryStore();
    const before = createTestEngine({ store });
    before.runners.dsh.script({ hold: true });
    const task = before.task();
    await before.engine.drain();
    const run = store.runs.list({ task_id: task.id })[0]!;
    await before.engine.shutdown();
    expect(before.runners.dsh.held()).toEqual([]); // aborted
    expect(store.runs.get(run.id)?.state).toBe('running'); // not finalized
    expect(store.tasks.get(task.id)).toMatchObject({ status: 'running', attempts: 0 });
    const ticked = await before.engine.tick();
    expect(ticked.dispatched).toEqual([]);

    const after = restart(store);
    await after.engine.recover();
    expect(store.runs.get(run.id)?.state).toBe('abandoned');
    const t = store.tasks.get(task.id)!;
    expect(t).toMatchObject({ status: 'queued', attempts: 0 });
    expect(t.recovery_note).toContain(run.dispatch_id);
  });

  it('a review run interrupted by a restart is re-reviewed, not re-implemented', async () => {
    const store = new InMemoryStore();
    const before = createTestEngine({ store });
    before.runners.dsh.script(editing(before.git, ['src/feature/a.ts']));
    before.runners.codex.script({ hold: true });
    const task = before.task();
    await before.engine.drain();
    expect(store.tasks.get(task.id)?.status).toBe('review');

    const reviewRun = store.runs.list({ task_id: task.id })[1]!;
    const after = restart(store, before.git);
    const report = await after.engine.recover();
    expect(report.requeuedTasks).toEqual([task.id]);
    const t = store.tasks.get(task.id)!;
    expect(t.status).toBe('review');
    expect(t.current_run_id).not.toBe(reviewRun.id);
    await after.engine.runUntilIdle();
    expect(store.runs.list({ task_id: task.id }).map((r) => `${r.kind}:${r.state}`)).toEqual([
      'impl:succeeded',
      'review:abandoned',
      'review:succeeded',
    ]);
    expect(after.runners.dsh.calls).toHaveLength(0);
    expect(store.tasks.get(task.id)?.status).toBe('done');
  });

  it('a leftover run.start effect for an abandoned run is a no-op (never relaunched)', async () => {
    const store = new InMemoryStore();
    const after = createTestEngine({ store });
    const task = after.task();
    const path = `/worktrees/demo/${task.id}`;
    const wt = await after.git.ensureWorktree({
      repoPath: '/repos/demo',
      worktreePath: path,
      branch: `team/${task.id}`,
      baseBranch: 'main',
    });
    // the state a crash leaves right after the dispatch transaction committed
    store.atomic((tx) => {
      const t = tx.tasks.get(task.id)!;
      tx.workspaces.insert(
        sampleWorkspace({ id: 'w_crash', task_id: task.id, path, base_sha: wt.baseSha }),
      );
      tx.runs.insert(
        sampleRun({
          id: 'r_crash',
          task_id: task.id,
          workspace_id: 'w_crash',
          dispatch_id: 'd_crash',
        }),
      );
      tx.tasks.update({ ...t, status: 'running', current_run_id: 'r_crash' }, t.version);
      const spec = {
        dispatchId: 'd_crash',
        cwd: path,
        prompt: 'x',
        schema: {},
        model: 'deepseek-flash',
        writable: true,
        logDir: '/data/runs/r_crash',
        timeoutMs: 1000,
      };
      tx.effects.upsert({
        kind: 'run.start',
        key: 'r_crash',
        payload: { run_id: 'r_crash', spec },
        due: t.created_at,
      });
    });

    await after.engine.recover();
    expect(store.runs.get('r_crash')?.state).toBe('abandoned');
    after.runners.dsh.defaultStep = editing(after.git, ['src/feature/a.ts']);
    await after.engine.runUntilIdle();
    expect(store.effects.get('run.start', 'r_crash')).toBeUndefined();
    expect(after.runners.dsh.calls.map((c) => c.dispatchId)).not.toContain('d_crash');
    expect(store.runs.list({ task_id: task.id })).toHaveLength(3); // abandoned + impl + review
    expect(store.tasks.get(task.id)?.status).toBe('done');
  });

  it('continues unfinished effects (verification) after a restart', async () => {
    const store = new InMemoryStore();
    const before = createTestEngine({ store });
    before.git.failNext('commitAll', 1);
    before.runners.dsh.script(editing(before.git, ['src/feature/a.ts']));
    const task = before.task();
    await before.engine.runUntilIdle();
    expect(store.tasks.get(task.id)?.status).toBe('verifying');

    const after = restart(store);
    // carry the worktree state over (same disk)
    for (const [p, wt] of before.git.worktrees) after.git.worktrees.set(p, wt);
    for (const [p, repo] of before.git.repos) after.git.repos.set(p, repo);
    await after.engine.recover();
    after.clock.advance(5000);
    await after.engine.runUntilIdle();
    expect(store.tasks.get(task.id)?.status).toBe('done');
  });

  it('removes worktrees without a DB record and clears pending idempotency records', async () => {
    const store = new InMemoryStore();
    const h = createTestEngine({ store });
    h.runners.dsh.script({ hold: true });
    const task = h.task();
    await h.engine.drain();
    const known = store.workspaces.findCurrentByTask(task.id)!.path;
    h.git.addStrayWorktree('/repos/demo', '/worktrees/demo/t_stray', 'team/t_stray');
    h.git.addStrayWorktree('/repos/demo', '/elsewhere/t_x', 'team/t_x');
    store.idempotency.insert({
      caller: 'cli',
      request_id: 'k',
      method: 'POST /api/tasks',
      payload_hash: 'b'.repeat(64),
      state: 'pending',
      response: null,
      created_at: '2026-11-21T00:00:00.000Z',
    });

    const report = await h.engine.recover();
    expect(report.orphanWorktrees).toEqual(['/worktrees/demo/t_stray']);
    expect(report.clearedIdempotency).toBe(1);
    await h.engine.drain();
    expect(h.git.worktrees.has('/worktrees/demo/t_stray')).toBe(false);
    expect(h.git.worktrees.has('/elsewhere/t_x')).toBe(true);
    expect(h.git.worktrees.has(known)).toBe(true);
    const removed = store.events.listAfter(0).find((e) => e.type === 'workspace.removed');
    expect(removed?.data).toEqual({
      workspace_id: null,
      path: '/worktrees/demo/t_stray',
      reason: 'orphan',
    });
    h.runners.dsh.release(undefined, { error: { kind: 'crash', message: 'x' } });
    await h.engine.runUntilIdle();
  });
});

describe('cleanup sweep', () => {
  it('removes worktrees of tasks finished more than 72 hours ago and keeps branches', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.runUntilIdle();
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    expect(ws.state).toBe('active');
    h.clock.advance(71 * 3600_000);
    await h.engine.runUntilIdle();
    expect(h.store.workspaces.get(ws.id)?.state).toBe('active');
    h.clock.advance(2 * 3600_000);
    await h.engine.runUntilIdle();
    expect(h.store.workspaces.get(ws.id)).toMatchObject({ state: 'removed' });
    expect(h.git.worktrees.has(ws.path)).toBe(false);
    expect(h.git.calls.filter((c) => c.method === 'removeWorktree')).toHaveLength(1);
  });

  it('a dirty worktree is never forced: kept, one attention item, no retry loop', async () => {
    const h = createTestEngine({ config: { notifications: false } });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.task();
    await h.engine.runUntilIdle();
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    h.git.touch(ws.path, ['src/feature/later.ts']); // someone edited after the task finished
    h.clock.advance(73 * 3600_000);
    await h.engine.runUntilIdle();
    h.clock.advance(24 * 3600_000);
    await h.engine.runUntilIdle();

    expect(h.store.workspaces.get(ws.id)?.state).toBe('kept');
    expect(h.git.worktrees.has(ws.path)).toBe(true);
    const removals = h.git.calls.filter((c) => c.method === 'removeWorktree');
    expect(removals.map((c) => c.input)).toEqual([
      { repoPath: '/repos/demo', worktreePath: ws.path, force: false },
    ]);
    expect(h.store.effects.list()).toEqual([]);
    const open = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
    expect(open).toHaveLength(1);
    expect(open[0]!.question).toContain('1 個未提交的變更');
    expect(h.eventTypes(task.id).filter((t) => t === 'workspace.kept')).toHaveLength(1);
  });

  it('recovery force-removes orphans (no workspace record) even when dirty', async () => {
    const h = createTestEngine();
    h.project();
    h.git.addStrayWorktree('/repos/demo', '/worktrees/demo/t_stray', 'team/t_stray');
    h.git.touch('/worktrees/demo/t_stray', ['junk.txt']);
    await h.engine.recover();
    await h.engine.runUntilIdle();
    expect(h.git.worktrees.has('/worktrees/demo/t_stray')).toBe(false);
    expect(h.git.calls.find((c) => c.method === 'removeWorktree')?.input).toMatchObject({
      force: true,
    });
  });
});
