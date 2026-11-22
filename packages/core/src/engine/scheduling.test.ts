import { defaultServiceConfig } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTestEngine } from '../testing/harness.js';
import { sampleRun, sampleTask, testModelsConfig } from '../testing/fixtures.js';
import { resolveRole } from './resolve-role.js';
import { planDispatch, type PlanInput } from './scheduler.js';

const NOW = new Date('2026-11-21T00:00:00.000Z');

function plan(overrides: Partial<PlanInput>) {
  const models = testModelsConfig();
  return planDispatch({
    tasks: [],
    liveRuns: [],
    dispatching: new Map(),
    dispatchingPaths: [],
    humanPriority: new Set(),
    models,
    engine: defaultServiceConfig().engine,
    now: NOW,
    resolve: (role, exclude) => {
      const all = {
        available: true,
        cooldown_until: null,
        cooldown_reason: null,
        consecutive_failures: 0,
        circuit_open_until: null,
        rate_limit_loops: 0,
        probe_after_cooldown: false,
        halted_at: null,
        halted_attention_id: null,
        quota: null,
      };
      return resolveRole(
        role,
        {
          claude: { ...all, runner: 'claude' },
          codex: { ...all, runner: 'codex' },
          dsh: { ...all, runner: 'dsh' },
        },
        { models, now: NOW, excludeAliases: exclude },
      );
    },
    implAliasOf: () => undefined,
    ...overrides,
  });
}

const queued = (id: string, extra: Parameters<typeof sampleTask>[0] = {}) =>
  sampleTask({ id, owned_paths: [`src/${id}/`], ...extra });

describe('§14 槽位與保留槽 — slots and the reserved human slot', () => {
  it('limits runs per role to roles.<role>.slots', () => {
    // impl_C has 3 slots in the test config
    const tasks = ['t_1', 't_2', 't_3', 't_4'].map((id) => queued(id));
    const result = plan({ tasks });
    expect(result.dispatch.map((d) => d.task.id)).toEqual(['t_1', 't_2', 't_3']);
    expect(result.deferred).toEqual([
      { task_id: 't_4', reason: 'role_slots', retry_at: null, detail: 'impl_C: 3 slot(s) in use' },
    ]);
  });

  it('counts live runs and in-preparation dispatches against the role', () => {
    const live = [sampleRun({ id: 'r_1', role: 'impl_C', state: 'running' })];
    const result = plan({
      tasks: [queued('t_1'), queued('t_2'), queued('t_3')],
      liveRuns: live,
      dispatching: new Map([['t_9', 'impl_C']]),
    });
    expect(result.dispatch.map((d) => d.task.id)).toEqual(['t_1']);
  });

  it('keeps reserved_human_slots free for human-triggered tasks', () => {
    const engine = {
      ...defaultServiceConfig().engine,
      max_concurrent_runs: 3,
      reserved_human_slots: 1,
    };
    const tasks = [
      queued('t_1', { impl_role: 'impl_B', tier: 'B' }),
      queued('t_2', { impl_role: 'impl_C' }),
      queued('t_3', { impl_role: 'impl_C' }),
    ];
    const auto = plan({ tasks, engine });
    expect(auto.dispatch.map((d) => d.task.id)).toEqual(['t_1', 't_2']);
    expect(auto.deferred).toEqual([{ task_id: 't_3', reason: 'global_cap', retry_at: null }]);

    const human = plan({ tasks, engine, humanPriority: new Set(['t_3']) });
    // the human task goes first and may use the reserved slot; non-human work stops at cap - 1
    expect(human.dispatch.map((d) => d.task.id)).toEqual(['t_3', 't_1']);
    expect(human.dispatch[0]!.human).toBe(true);
    expect(human.deferred.map((d) => d.task_id)).toEqual(['t_2']);
  });

  it('lets a human task use the last slot when everything else is busy', () => {
    const engine = {
      ...defaultServiceConfig().engine,
      max_concurrent_runs: 2,
      reserved_human_slots: 1,
    };
    const live = [sampleRun({ id: 'r_1', role: 'impl_B', state: 'running' })];
    const tasks = [queued('t_1'), queued('t_2')];
    expect(plan({ tasks, engine, liveRuns: live }).dispatch).toEqual([]);
    const human = plan({ tasks, engine, liveRuns: live, humanPriority: new Set(['t_2']) });
    expect(human.dispatch.map((d) => d.task.id)).toEqual(['t_2']);
  });
});

describe('§14 路徑交集 — owned_paths overlap', () => {
  it('does not dispatch a task whose paths overlap a running/verifying/review task', () => {
    const tasks = [
      sampleTask({
        id: 't_run',
        status: 'running',
        current_run_id: 'r_1',
        owned_paths: ['src/a/'],
      }),
      sampleTask({
        id: 't_rev',
        status: 'review',
        current_run_id: 'r_2',
        owned_paths: ['docs/x.md'],
      }),
      queued('t_1', { owned_paths: ['src/a/b.ts'] }),
      queued('t_2', { owned_paths: ['docs/'] }),
      queued('t_3', { owned_paths: ['src/b/'] }),
    ];
    const result = plan({ tasks });
    expect(result.dispatch.map((d) => d.task.id)).toEqual(['t_3']);
    expect(
      result.deferred.filter((d) => d.reason === 'path_overlap').map((d) => d.task_id),
    ).toEqual(['t_1', 't_2']);
  });

  it('treats uncertain patterns as overlapping and checks tasks dispatched in the same pass', () => {
    const tasks = [
      queued('t_1', { owned_paths: ['src/**'] }),
      queued('t_2', { owned_paths: ['src/x/y.ts'] }),
      queued('t_3', { owned_paths: ['**/*.md'] }),
      queued('t_4', { owned_paths: ['lib/'] }),
    ];
    const result = plan({ tasks });
    // `**/*.md` starts with a glob: uncertain → overlaps; `lib/` is clearly disjoint from `src/**`
    expect(result.dispatch.map((d) => d.task.id)).toEqual(['t_1', 't_4']);
    expect(result.deferred.map((d) => d.task_id)).toEqual(['t_2', 't_3']);
  });

  it('skips the overlap check for read-only review runs', () => {
    const tasks = [
      sampleTask({ id: 't_run', status: 'running', current_run_id: 'r_1', owned_paths: ['src/'] }),
      sampleTask({ id: 't_rev', status: 'review', owned_paths: ['src/'] }),
    ];
    expect(plan({ tasks }).dispatch.map((d) => [d.task.id, d.kind])).toEqual([['t_rev', 'review']]);
  });
});

describe('ordering and backoff', () => {
  it('takes higher priority first, then older tasks', () => {
    const tasks = [
      queued('t_old', { created_at: '2026-11-20T00:00:00.000Z' }),
      queued('t_new', { created_at: '2026-11-22T00:00:00.000Z', priority: 5 }),
      queued('t_mid', { created_at: '2026-11-21T00:00:00.000Z' }),
    ];
    expect(plan({ tasks }).dispatch.map((d) => d.task.id)).toEqual(['t_new', 't_old', 't_mid']);
  });

  it('waits for retry_at', () => {
    const tasks = [queued('t_1', { retry_at: '2026-11-21T00:01:00.000Z' })];
    expect(plan({ tasks }).deferred).toEqual([
      { task_id: 't_1', reason: 'backoff', retry_at: '2026-11-21T00:01:00.000Z' },
    ]);
  });
});

describe('engine scheduling end to end', () => {
  it('dispatches up to the slot limit and the rest after runs finish', async () => {
    const h = createTestEngine();
    h.runners.dsh.defaultStep = { hold: true };
    const tasks = ['a', 'b', 'c', 'd'].map((p) => h.task({ owned_paths: [`src/${p}/`] }));
    await h.engine.drain();
    expect(h.store.runs.list({ states: ['running'] })).toHaveLength(3);
    expect(h.get(tasks[3]!.id).status).toBe('queued');

    h.runners.dsh.defaultStep = {};
    for (const id of h.runners.dsh.held()) h.runners.dsh.release(id);
    await h.engine.runUntilIdle();
    expect(h.store.runs.list({ task_id: tasks[3]!.id }).length).toBeGreaterThan(0);
  });

  it('a human retry jumps the queue and may use the reserved slot', async () => {
    const h = createTestEngine({
      config: {
        engine: {
          ...defaultServiceConfig().engine,
          max_concurrent_runs: 2,
          reserved_human_slots: 1,
        },
      },
    });
    h.runners.dsh.defaultStep = { hold: true };
    h.task({ owned_paths: ['src/a/'] });
    const second = h.task({ owned_paths: ['src/b/'] });
    await h.engine.drain();
    expect(h.store.runs.list({ states: ['running'] })).toHaveLength(1);
    expect(h.get(second.id).status).toBe('queued');

    // the human acts on the waiting task: it may take the reserved slot
    h.engine.reassignTask(second.id, 'impl_C');
    await h.engine.drain();
    expect(h.get(second.id).status).toBe('running');
    expect(h.store.runs.list({ states: ['running'] })).toHaveLength(2);
    h.runners.dsh.defaultStep = {};
    for (const id of h.runners.dsh.held()) h.runners.dsh.release(id);
    await h.engine.runUntilIdle();
  });
});
