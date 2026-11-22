import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestService, local, type Loose, type TestService } from '../testing/harness.js';
import { REPLAYED_HEADER } from './idempotency.js';

// docs/adr/0022 §1: every task command answers with `delivery` (from the stored state after one
// scheduling pass) and a generated `report`; GET /state carries a summary whose counts sum.

let h: TestService;
let app: ReturnType<TestService['localApp']>;
let projectId: string;

beforeEach(async () => {
  h = createTestService();
  app = h.localApp();
  const res = await app.request(
    '/api/projects',
    local({ name: 'demo', repo_path: '/repos/demo', checks: [] }),
  );
  projectId = ((await res.json()) as Loose).project.id;
});
afterEach(async () => {
  await h.cleanup();
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await app.request(path, local(body, headers));
  return { status: res.status, body: (await res.json()) as Loose, headers: res.headers };
};
const ticket = (title: string, queue: boolean, paths = ['src/a']) => ({
  project_id: projectId,
  title,
  tier: 'C',
  ticket_md: '# 派工單',
  owned_paths: paths,
  queue,
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('task command delivery (docs/adr/0022)', () => {
  it('a draft says it will not run until queued', async () => {
    const res = await post('/api/tasks', ticket('草稿單', false));
    expect(res.status).toBe(201);
    expect(res.body.delivery).toEqual({
      state: 'draft',
      waiting: null,
      run_id: null,
      reason: null,
    });
    expect(res.body.report).toBe(
      `任務 ${res.body.task.id}「草稿單」是草稿：尚未排入佇列，不會執行（要派工請用 team task queue ${res.body.task.id}）。`,
    );
  });

  it('a queued task the scheduler dispatched at once is running, with its run', async () => {
    h.runners.dsh.script({ hold: true });
    const res = await post('/api/tasks', ticket('立刻派', true));
    expect(res.body.task.status).toBe('running');
    expect(res.body.delivery.state).toBe('running');
    const run = h.store.runs.list({ task_id: res.body.task.id })[0]!;
    expect(res.body.delivery.run_id).toBe(run.id);
    expect(res.body.report).toBe(`任務 ${res.body.task.id}「立刻派」正在執行（run ${run.id}）。`);
    h.runners.dsh.release();
  });

  it('a queued task that waits says why, and never that it runs', async () => {
    h.runners.dsh.script({ hold: true });
    const first = await post('/api/tasks', ticket('先來', true));
    const second = await post('/api/tasks', ticket('後到', true));
    expect(second.body.task.status).toBe('queued');
    expect(second.body.delivery).toMatchObject({
      state: 'queued',
      run_id: null,
      waiting: { reason: 'path_overlap', blocking_task_id: first.body.task.id },
    });
    expect(second.body.report).toBe(
      `任務 ${second.body.task.id}「後到」已排入佇列，尚未開始執行（owned_paths 與進行中的任務 ${first.body.task.id} 重疊）。`,
    );
    expect(second.body.report).not.toMatch(/正在執行/);
    h.runners.dsh.release();
  });

  it('queue and retry answer with the delivery; a refused command is a plain error', async () => {
    const draft = await post('/api/tasks', ticket('之後再排', false));
    const id = draft.body.task.id as string;
    h.runners.dsh.script({ hold: true });
    const queued = await post(`/api/tasks/${id}/queue`, {});
    expect(queued.status).toBe(200);
    expect(queued.body.delivery.state).toBe('running');
    const again = await post(`/api/tasks/${id}/queue`, {});
    expect(again.status).toBe(409);
    expect(again.body.delivery).toBeUndefined();
    const cancelled = await post(`/api/tasks/${id}/cancel`, {});
    expect(cancelled.body.delivery).toMatchObject({ state: 'not_accepted', reason: '任務已取消' });
    expect(cancelled.body.report).toBe(`任務 ${id}「之後再排」已取消，不會執行。`);
  });

  it('a replayed create (same Idempotency-Key) gets the delivery as it is now', async () => {
    h.runners.dsh.script({ hold: true });
    const key = { [IDEMPOTENCY_HEADER]: 'leader:turn-1:abc' };
    const first = await post('/api/tasks', ticket('重放', true), key);
    expect(first.body.delivery.state).toBe('running');
    const id = first.body.task.id as string;
    await post(`/api/tasks/${id}/cancel`, {});
    await until(() => h.store.runs.list({ task_id: id }).every((r) => r.state !== 'starting'));

    const replay = await post('/api/tasks', ticket('重放', true), key);
    expect(replay.headers.get(REPLAYED_HEADER)).toBe('true');
    expect(h.store.tasks.list()).toHaveLength(1); // not created twice
    expect(replay.body.task).toMatchObject({ id, status: 'cancelled' });
    expect(replay.body.delivery).toMatchObject({ state: 'not_accepted', reason: '任務已取消' });
    expect(replay.body.report).toBe(`任務 ${id}「重放」已取消，不會執行。`);
  });

  it('GET /state: counts per board column sum to the total; cancelled tasks are counted apart', async () => {
    h.runners.dsh.script({ hold: true });
    await post('/api/tasks', ticket('一', true, ['src/a']));
    await post('/api/tasks', ticket('二', true, ['src/a']));
    await post('/api/tasks', ticket('三', false, ['src/b']));
    const gone = await post('/api/tasks', ticket('四', false, ['src/c']));
    await post(`/api/tasks/${gone.body.task.id}/cancel`, {});
    const state = (await (await app.request('/api/state', local())).json()) as Loose;
    const s = state.summary;
    expect(s).toMatchObject({
      total: 3,
      columns: { pending: 2, in_progress: 1, review: 0, blocked: 0, done: 0 },
      drafts: 1,
      queued: 1,
      cancelled: 1,
    });
    const columns = Object.values(s.columns as Record<string, number>);
    expect(columns.reduce((a, b) => a + b, 0)).toBe(s.total);
    expect(s.report).toBe(
      '看板共 3 個任務：待派 2（草稿 1、排隊 1，都尚未執行）、進行中 1、待驗收 0、阻塞 0、完成 0；另有 1 個已取消（不在看板上）。',
    );
    h.runners.dsh.release();
  });
});
