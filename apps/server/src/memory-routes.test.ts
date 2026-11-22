import { noopLogger } from '@agent-team/core';
import { editing } from '@agent-team/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemosMemory } from './memory/memos.js';
import { FakeMemos } from './testing/fake-memos.js';
import {
  createTestService,
  local,
  SOURCE_HEADER,
  TEST_LEADER_TOKEN,
  TEST_PASSWORD,
  type Loose,
  type TestService,
} from './testing/harness.js';

// spec §18 at the server: the memory routes and their actor rules, nothing reaching MemOS while
// memory is off, `team doctor`, and the whole path — a finished task is written, the next
// dispatch of the project gets it in its prompt — against a fake MemOS on loopback.

let fake: FakeMemos;
let h: TestService | undefined;
beforeEach(async () => {
  fake = new FakeMemos();
  await fake.start();
});
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await fake.stop();
});

function start(enabled = true): TestService {
  h = createTestService({
    configure: (c) => {
      c.memory = { ...c.memory, enabled, base_url: fake.url, add_mode: 'sync_fast' };
    },
    memory: (store, config) =>
      createMemosMemory({ settings: config.memory, kv: store.kv, logger: noopLogger }),
  });
  return h;
}

async function call(t: TestService, path: string, body?: unknown, token?: string) {
  const res = await t.localApp().request(path, local(body, {}, token));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Loose };
}

const project = (t: TestService) =>
  t.service.engine.createProject({ name: 'demo', repo_path: '/repos/demo' });

describe('§18 memory API', () => {
  it('off: every route answers 409, doctor says off, nothing reaches MemOS', async () => {
    const t = start(false);
    const p = project(t);
    for (const [path, body] of [
      [`/api/projects/${p.id}/memory/search?q=x`, undefined],
      [`/api/projects/${p.id}/memory`, undefined],
      [`/api/projects/${p.id}/memory`, { text: 'x' }],
    ] as const) {
      expect((await call(t, path, body)).status).toBe(409);
    }
    const doctor = await call(t, '/api/doctor');
    expect(doctor.body.checks).toContainEqual({
      name: 'memory',
      ok: true,
      detail: 'off (service.json memory.enabled = false)',
    });
    t.service.engine.createTask({
      project_id: p.id,
      title: 't',
      tier: 'C',
      ticket_md: 'x',
      owned_paths: ['src/'],
      queue: true,
    });
    await t.service.engine.runUntilIdle();
    expect(fake.requests).toHaveLength(0);
  });

  it('a person adds, lists and deletes; the leader may only search', async () => {
    const t = start();
    const p = project(t);
    const added = await call(t, `/api/projects/${p.id}/memory`, { text: '記得用 pnpm' });
    expect(added.status).toBe(202);
    expect(added.body).toMatchObject({ project_id: p.id, queued: true });
    expect(added.body.source_id).toMatch(/^n_/);
    await t.service.engine.runUntilIdle();
    expect(fake.nodes.map((n) => n.memory)).toEqual(['user: 記得用 pnpm\n']);

    const list = await call(t, `/api/projects/${p.id}/memory?page=1&page_size=10`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, page_size: 10 });
    expect(list.body.memories[0]).toMatchObject({ text: '記得用 pnpm', source: 'human' });

    const found = await call(
      t,
      `/api/projects/${p.id}/memory/search?q=${encodeURIComponent('pnpm 安裝')}`,
      undefined,
      TEST_LEADER_TOKEN,
    );
    expect(found.status).toBe(200);
    expect(found.body.memories).toHaveLength(1);

    const id = list.body.memories[0].id as string;
    for (const [path, body] of [
      [`/api/projects/${p.id}/memory`, undefined],
      [`/api/projects/${p.id}/memory`, { text: 'x' }],
      [`/api/projects/${p.id}/memory/${id}/delete`, {}],
    ] as const) {
      const res = await call(t, path, body, TEST_LEADER_TOKEN);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    const foreign = fake.seed('someone-elses-cube', 'user: 別人的\n');
    expect((await call(t, `/api/projects/${p.id}/memory/${foreign.id}/delete`, {})).status).toBe(
      404,
    );
    const removed = await call(t, `/api/projects/${p.id}/memory/${id}/delete`, {});
    expect(removed).toMatchObject({ status: 200, body: { memory_id: id, removed: true } });
    expect(fake.nodes.map((n) => n.cube)).toEqual(['someone-elses-cube']);
  });

  it('the board (LAN) lists the memory of a project', async () => {
    const t = start();
    const p = project(t);
    t.service.engine.addMemory(p.id, '板子上的筆記');
    await t.service.engine.runUntilIdle();
    const app = t.lanApp();
    const host = '192.168.1.20:4518';
    const headers = { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' };
    const login = await app.request(`http://${host}/auth/login`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', [SOURCE_HEADER]: 'a' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const res = await app.request(`http://${host}/api/projects/${p.id}/memory`, {
      headers: { ...headers, cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Loose).memories[0].text).toBe('板子上的筆記');
  });

  it('MemOS down: 503 on the entrances; doctor reports it without the address', async () => {
    const t = start();
    const p = project(t);
    fake.failStatus = 500;
    const res = await call(t, `/api/projects/${p.id}/memory/search?q=x`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('unavailable');
    const port = new URL(fake.url).port;
    await fake.stop();
    const doctor = await call(t, '/api/doctor');
    const check = (doctor.body.checks as Loose[]).find((c) => c.name === 'memory');
    expect(check).toMatchObject({ ok: false });
    expect(check.detail).toContain('/health unreachable');
    expect(JSON.stringify(doctor.body)).not.toContain(port);
  });

  it('a finished task is written; the next task of the project gets it in its prompt', async () => {
    const t = start();
    const p = project(t);
    for (const r of Object.values(t.runners)) r.defaultStep = editing(t.git, ['src/a.ts']);
    const task = (title: string) =>
      t.service.engine.createTask({
        project_id: p.id,
        title,
        tier: 'C',
        ticket_md: `# ${title}\n資料庫 層`,
        owned_paths: ['src/'],
        queue: true,
      });
    const first = task('資料庫 第一張');
    await t.service.engine.runUntilIdle();
    expect(t.store.tasks.get(first.id)!.status).toBe('done');
    expect(fake.nodes).toHaveLength(1);
    expect(fake.nodes[0]!.metadata).toMatchObject({
      team_source: 'task',
      team_source_id: first.id,
    });

    const second = task('資料庫 第二張');
    await t.service.engine.runUntilIdle();
    const impl = t.runners.dsh.calls.at(-1)!.prompt;
    expect(impl).toContain('## 專案記憶');
    expect(impl).toContain(`任務完成：資料庫 第一張（${first.id}`);
    const run = t.store.runs.list({ task_id: second.id })[0]!;
    expect(run.memory_ids).toEqual([fake.nodes[0]!.id]);
  });
});
