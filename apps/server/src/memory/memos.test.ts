import { InMemoryStore, noopLogger } from '@agent-team/core';
import { defaultServiceConfig, type MemorySettings } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMemos } from '../testing/fake-memos.js';
import { createMemosTransport, MemosError } from './memos-http.js';
import { createMemosMemory, type MemosMemory } from './memos.js';

// spec §18 / docs/adr/0023: the HTTP adapter against a fake MemOS on loopback (never the NAS).

const PROJECT = 'p_aaaaaaaaaaaa';
const OTHER = 'p_bbbbbbbbbbbb';
const CUBE = `agent-team-${PROJECT}`;

let fake: FakeMemos;
let store: InMemoryStore;

function adapter(overrides: Partial<MemorySettings> = {}): MemosMemory {
  return createMemosMemory({
    settings: {
      ...defaultServiceConfig().memory,
      enabled: true,
      base_url: fake.url,
      ...overrides,
    },
    kv: store.kv,
    logger: noopLogger,
  });
}

const write = (text: string, over: Record<string, unknown> = {}) => ({
  source: 'task' as const,
  sourceId: 't_000001',
  taskId: 't_000001',
  text,
  at: '2026-11-22T01:02:03.000Z',
  ...over,
});

beforeEach(async () => {
  fake = new FakeMemos();
  await fake.start();
  store = new InMemoryStore();
});
afterEach(() => fake.stop());

const requests = (path: string) => fake.requests.filter((r) => r.path === path);

describe('§18 MemOS adapter: writes', () => {
  it('names the cube explicitly, uses the fixed user id, async mode and namespaced info', async () => {
    await adapter({ add_mode: 'async' }).add(PROJECT, write('任務完成：功能 A'));
    const [add] = requests('/product/add');
    expect(add!.body).toEqual({
      user_id: 'agent-team',
      writable_cube_ids: [CUBE],
      messages: [{ role: 'user', content: '任務完成：功能 A' }],
      async_mode: 'async',
      info: {
        team_source: 'task',
        team_source_id: 't_000001',
        team_project_id: PROJECT,
        team_at: '2026-11-22T01:02:03.000Z',
        team_task_id: 't_000001',
      },
    });
    expect(fake.nodes.map((n) => n.cube)).toEqual([CUBE]);
  });

  it('sync_fast, the default, stores the text as given (async_mode sync, mode fast)', async () => {
    await adapter().add(PROJECT, write('x'));
    expect(requests('/product/add')[0]!.body).toMatchObject({ async_mode: 'sync', mode: 'fast' });
  });

  it('registers the cube once; a refusal is remembered and does not block writes', async () => {
    const memory = adapter();
    await memory.add(PROJECT, write('a'));
    await memory.add(PROJECT, write('b', { sourceId: 't_000002' }));
    expect(requests('/product/create_cube')).toHaveLength(1);
    expect(requests('/product/create_cube')[0]!.body).toEqual({
      cube_id: CUBE,
      cube_name: CUBE,
      owner_id: 'agent-team',
    });
    expect(store.kv.get(`memory:cube:${CUBE}`)).toBe('refused:400'); // unknown owner
    expect(requests('/product/add')).toHaveLength(2);

    const known = new FakeMemos({ users: ['agent-team'] });
    await known.start();
    try {
      const fresh = new InMemoryStore();
      const m = createMemosMemory({
        settings: { ...defaultServiceConfig().memory, enabled: true, base_url: known.url },
        kv: fresh.kv,
        logger: noopLogger,
      });
      await m.add(PROJECT, write('a'));
      expect(fresh.kv.get(`memory:cube:${CUBE}`)).toBe('created');
      expect(known.cubes.has(CUBE)).toBe(true);
    } finally {
      await known.stop();
    }
  });
});

describe('§18 MemOS adapter: reads', () => {
  it('search: explicit cube, mode fast, top_k and relativity, text memory only; items mapped', async () => {
    const memory = adapter();
    await memory.add(PROJECT, write('資料庫 用 SQLite'));
    fake.seed(`agent-team-${OTHER}`, 'user: 資料庫 別的專案\n');
    fake.seed('someone-elses-cube', 'user: 資料庫 別人的\n');
    const hits = await memory.search(PROJECT, '資料庫 層', 6);
    expect(requests('/product/search')[0]!.body).toEqual({
      query: '資料庫 層',
      user_id: 'agent-team',
      readable_cube_ids: [CUBE],
      mode: 'fast',
      top_k: 6,
      relativity: 0.45,
      include_preference: false,
      search_tool_memory: false,
      include_skill_memory: false,
    });
    expect(hits).toEqual([
      {
        id: fake.nodes[0]!.id,
        text: '資料庫 用 SQLite',
        source: 'task',
        source_id: 't_000001',
        task_id: 't_000001',
        created_at: '2026-11-22T01:02:03.000Z',
        searchable: true,
        relativity: 0.9,
      },
    ]);
  });

  it('ignores buckets of other cubes in a response', async () => {
    const bucket = (cube: string, id: string) => ({
      cube_id: cube,
      memories: [{ id, memory: 'user: x\n', metadata: { memory_type: 'LongTermMemory' } }],
    });
    const memory = createMemosMemory({
      settings: { ...defaultServiceConfig().memory, enabled: true, base_url: 'http://memos.test' },
      kv: store.kv,
      logger: noopLogger,
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: 200,
            message: 'ok',
            data: {
              text_mem: [
                bucket('agent-team-p_cccccccccccc', '22222222-2222-4222-8222-000000000001'),
                bucket(CUBE, '22222222-2222-4222-8222-000000000002'),
              ],
            },
          }),
        ),
    });
    const hits = await memory.search(PROJECT, 'x', 6);
    expect(hits.map((h) => h.id)).toEqual(['22222222-2222-4222-8222-000000000002']);
    expect(hits[0]!.source).toBeNull(); // no source of ours: unverified
  });

  it('an item MemOS rewrote after an async add has no source of ours (shown as unverified)', async () => {
    const memory = adapter({ add_mode: 'async' });
    await memory.add(PROJECT, write('用 pnpm'));
    const before = fake.nodes[0]!.id;
    fake.settle();
    const { items, total } = await memory.list(PROJECT, { page: 1, pageSize: 20 });
    expect(total).toBe(1);
    expect(items[0]!.id).not.toBe(before);
    expect(items[0]).toMatchObject({ text: '摘要：用 pnpm', source: null });
  });

  it('list: one cube, paged, newest first; items without a vector are marked unsearchable', async () => {
    const memory = adapter();
    await memory.add(PROJECT, write('一'));
    fake.noVector = true;
    await memory.add(PROJECT, write('二', { source: 'human', sourceId: 'n_000001', taskId: null }));
    fake.seed('someone-elses-cube', 'user: 別人的\n');
    const page = await memory.list(PROJECT, { page: 1, pageSize: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toEqual([
      expect.objectContaining({ text: '二', source: 'human', task_id: null, searchable: false }),
    ]);
    expect(requests('/product/get_memory')[0]!.body).toMatchObject({
      mem_cube_id: CUBE,
      page: 1,
      page_size: 1,
      include_preference: false,
    });
  });
});

describe('§18 MemOS adapter: deletes', () => {
  it('proves the id is in the project cube before deleting it by id, then checks it is gone', async () => {
    const memory = adapter();
    await memory.add(PROJECT, write('要刪的'));
    const id = fake.nodes[0]!.id;
    expect(await memory.remove(PROJECT, id)).toBe(true);
    expect(fake.nodes).toHaveLength(0);
    const [del] = requests('/product/delete_memory');
    expect(del!.body).toEqual({
      memory_ids: [id],
      writable_cube_ids: [CUBE],
      auto_cleanup_working: true,
    });
    expect(requests('/product/get_memory').map((r) => r.body['filter'])).toEqual([
      { and: [{ id }] },
      { and: [{ id }] },
    ]);
  });

  it('never deletes an item of another cube (MemOS would: its delete by id is not scoped)', async () => {
    const memory = adapter();
    const foreign = fake.seed('someone-elses-cube', 'user: 別人的\n');
    const otherProject = fake.seed(`agent-team-${OTHER}`, 'user: 別的專案\n');
    expect(await memory.remove(PROJECT, foreign.id)).toBe(false);
    expect(await memory.remove(PROJECT, otherProject.id)).toBe(false);
    expect(await memory.remove(PROJECT, 'not-a-uuid')).toBe(false);
    expect(requests('/product/delete_memory')).toHaveLength(0);
    expect(fake.nodes).toHaveLength(2);
  });

  it('a 200 with status failure, or an item still listed afterwards, is an error', async () => {
    const id = '33333333-3333-4333-8333-000000000001';
    const stub = (deleteStatus: string) =>
      createMemosMemory({
        settings: {
          ...defaultServiceConfig().memory,
          enabled: true,
          base_url: 'http://memos.test',
        },
        kv: store.kv,
        logger: noopLogger,
        fetch: async (url) => {
          const data = String(url).endsWith('/delete_memory')
            ? { status: deleteStatus }
            : {
                text_mem: [{ cube_id: CUBE, memories: [{ id, memory: 'user: x', metadata: {} }] }],
              };
          return new Response(JSON.stringify({ code: 200, message: 'ok', data }));
        },
      });
    await expect(stub('failure').remove(PROJECT, id)).rejects.toThrow('reported a failure');
    await expect(stub('success').remove(PROJECT, id)).rejects.toThrow('still lists the item');
  });
});

describe('§18 MemOS adapter: guards and errors', () => {
  it('refuses cubes without the prefix and bulk deletes before sending anything', async () => {
    const http = createMemosTransport({ baseUrl: fake.url, cubePrefix: 'agent-team-' });
    const refused = [
      ['/search', { query: 'x', user_id: 'u', readable_cube_ids: ['someone-elses-cube'] }],
      ['/search', { query: 'x', user_id: 'u' }],
      ['/add', { user_id: 'u', messages: [] }],
      ['/add', { user_id: 'u', writable_cube_ids: [] }],
      ['/get_memory', { mem_cube_id: 'agent-team-' }],
      ['/delete_memory', { memory_ids: ['x'], writable_cube_ids: [CUBE], user_id: 'u' }],
      ['/delete_memory', { writable_cube_ids: [CUBE], filter: { and: [{ a: 1 }] } }],
      ['/delete_memory', { memory_ids: ['x'] }],
    ] as const;
    for (const [path, body] of refused) {
      await expect(http.post(path, { ...body }, 1000)).rejects.toThrow(MemosError);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('timeouts, refusals and HTTP errors name the path, never the address', async () => {
    const memory = adapter({ timeout_ms: 50 });
    fake.delayMs = 300;
    const timeout = await memory.search(PROJECT, 'x', 6).catch((e: unknown) => e);
    expect(String(timeout)).toContain('MemOS /product/search timed out after 50 ms');
    fake.delayMs = 0;
    fake.failStatus = 500;
    await expect(memory.search(PROJECT, 'x', 6)).rejects.toThrow(
      'MemOS /product/search answered 500',
    );
    const port = new URL(fake.url).port;
    await fake.stop();
    const down = await memory.search(PROJECT, 'x', 6).catch((e: unknown) => e);
    expect(String(down)).toMatch(/MemOS \/product\/search unreachable \(ECONNREFUSED\)/);
    for (const err of [timeout, down]) {
      expect(String(err)).not.toContain('127.0.0.1');
      expect(String(err)).not.toContain(port);
    }
    expect((await memory.health()).ok).toBe(false);
  });

  it('health reports the MemOS version', async () => {
    expect(await adapter().health()).toEqual({ ok: true, detail: 'healthy (MemOS 1.0.1)' });
  });
});
