import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { editing, sampleRun } from '@agent-team/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { watchRunLogs } from '../run-log-watch.js';
import { createTestService, local, type Loose, type TestService } from '../testing/harness.js';
import { cardFields } from './board.js';

// GET /api/state carries what every card shows (latest run, head sha, run totals), so the board
// needs no per-card request; GET /api/roles lists config/models.json; `run.log_advanced` events
// follow a live run's log.

let h: TestService;
let booted = false;
afterEach(async () => {
  if (booted) await h.cleanup();
  booted = false;
});

function boot(): TestService {
  h = createTestService();
  booted = true;
  return h;
}

async function call(path: string, body?: unknown) {
  const res = await h.localApp().request(path, local(body));
  return { status: res.status, body: (await res.json()) as Loose };
}

describe('board snapshot — card fields', () => {
  it('picks the current run (else the newest), sums the runs and takes the workspace head', () => {
    const a = sampleRun({
      id: 'r_1',
      started_at: '2026-11-21T00:00:00.000Z',
      ended_at: '2026-11-21T00:01:00.000Z',
      cost_usd: 0.1,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const b = sampleRun({
      id: 'r_2',
      kind: 'review',
      state: 'running',
      started_at: '2026-11-21T00:02:00.000Z',
      ended_at: null,
      cost_usd: null,
      usage: { input_tokens: 5, cache_read_tokens: 7 },
    });
    const fields = cardFields({ current_run_id: null }, [a, b], { head_sha: 'abc1234' });
    expect(fields.latest_run).toMatchObject({ id: 'r_2', kind: 'review', state: 'running' });
    expect(fields.head_sha).toBe('abc1234');
    expect(fields.run_totals).toEqual({
      runs: 2,
      cost_usd: 0.1,
      cost_estimated: false,
      usage: { input_tokens: 105, output_tokens: 20, cache_read_tokens: 7 },
      finished_ms: 60_000,
    });
    expect(cardFields({ current_run_id: 'r_1' }, [a, b], undefined).latest_run?.id).toBe('r_1');
    expect(cardFields({ current_run_id: null }, [], undefined)).toEqual({
      latest_run: null,
      head_sha: null,
      run_totals: { runs: 0, cost_usd: null, cost_estimated: false, usage: {}, finished_ms: 0 },
    });
  });

  it('GET /api/state: a finished task carries its latest run, commit and totals', async () => {
    boot();
    const project = h.service.engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const task = h.service.engine.createTask({
      project_id: project.id,
      title: '加一個功能',
      tier: 'C',
      ticket_md: '# 派工單',
      owned_paths: ['src/feature/'],
      queue: true,
    });
    await h.service.engine.runUntilIdle();
    const { body } = await call('/api/state');
    const card = (body.tasks as Loose[]).find((t) => t.id === task.id);
    expect(card.status).toBe('done');
    expect(card.latest_run).toMatchObject({ kind: 'review', state: 'succeeded', runner: 'codex' });
    expect(card.head_sha).toMatch(/^[0-9a-f]{7,64}$/);
    expect(card.run_totals).toMatchObject({ runs: 2, cost_usd: 0.02 });
    expect(card.run_totals.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
  });
});

describe('GET /api/roles', () => {
  it('lists the roles of config/models.json with alias, runner, slots, enabled, fallback', async () => {
    boot();
    const { status, body } = await call('/api/roles');
    expect(status).toBe(200);
    const byName = new Map((body.roles as Loose[]).map((r) => [r.name, r]));
    expect(byName.get('impl_B')).toEqual({
      name: 'impl_B',
      description: null,
      model_alias: 'gpt-sol',
      runner: 'codex',
      slots: 2,
      enabled: true,
      fallback: ['kimi-pro', 'sonnet'],
    });
    expect(byName.get('gate')).toMatchObject({ enabled: false, runner: 'jev' });
  });
});

describe('run.log_advanced — live log tails', () => {
  it('one event per poll for a live run whose log grew (run id + byte offset only)', async () => {
    boot();
    const project = h.service.engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
    h.runners.dsh.script({ hold: true });
    h.service.engine.createTask({
      project_id: project.id,
      title: '長時間的任務',
      tier: 'C',
      ticket_md: '# 派工單',
      owned_paths: ['src/feature/'],
      queue: true,
    });
    await h.service.engine.drain();
    const run = h.store.runs.list({ states: ['running'] })[0]!;
    const watcher = watchRunLogs({
      store: h.store,
      engine: h.service.engine,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      timer: false,
    });
    const logEvents = () =>
      h.store.events.listAfter(0).filter((e) => e.type === 'run.log_advanced');

    await watcher.poll(); // nothing written yet
    expect(logEvents()).toEqual([]);
    mkdirSync(run.log_dir, { recursive: true });
    const file = join(run.log_dir, 'events.jsonl');
    writeFileSync(file, '{"type":"system"}\n');
    await watcher.poll();
    await watcher.poll(); // unchanged: no second event
    appendFileSync(file, '{"type":"assistant"}\n{"type":"assistant"}\n');
    await watcher.poll();
    expect(logEvents().map((e) => [e.run_id, e.task_id, e.data])).toEqual([
      [run.id, null, { offset: 18 }],
      [run.id, null, { offset: 60 }],
    ]);

    h.service.engine.cancelTask(run.task_id);
    await h.service.engine.runUntilIdle();
    appendFileSync(file, 'more\n');
    await watcher.poll(); // the run is over: no more events
    expect(logEvents()).toHaveLength(2);
    watcher.stop();
  });
});
