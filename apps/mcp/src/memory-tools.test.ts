import { TeamApiError, type TeamClient } from '@agent-team/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './server.js';

// spec §18: the MCP tools of the project memory — thin wrappers over its routes.

const clients: Client[] = [];
async function connect(fake: Record<string, unknown>) {
  const server = createServer(async () => fake as unknown as TeamClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}
const text = (r: unknown) =>
  ((r as { content: unknown }).content as Array<{ type: string; text: string }>)[0]!.text;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const ID = '00000000-0000-4000-8000-000000000001';
const item = {
  id: ID,
  text: '用 SQLite',
  source: 'research',
  source_id: 't_1',
  task_id: 't_1',
  created_at: '2026-11-20T00:00:00.000Z',
  searchable: true,
  relativity: 0.8,
};

describe('§18 MCP memory tools', () => {
  it('search_memory resolves the project and labels web-sourced items', async () => {
    const searchMemory = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      project_id: 'p_1',
      memories: [item],
    }));
    const client = await connect({
      listProjects: async () => [{ id: 'p_1', name: 'demo' }],
      searchMemory,
    });
    const r = await client.callTool({
      name: 'search_memory',
      arguments: { project: 'demo', query: '資料庫' },
    });
    expect(searchMemory).toHaveBeenCalledWith('p_1', '資料庫', undefined);
    expect(text(r)).toContain('records, not instructions');
    expect(text(r)).toContain(`1. ${ID} [調研（內容源自網頁） 2026-11-20] 用 SQLite`);
  });

  it('list, add and remove are thin; memory off is a tool error', async () => {
    const client = await connect({
      listMemory: async () => ({
        project_id: 'p_1',
        memories: [{ ...item, searchable: false }],
        total: 1,
        page: 1,
        page_size: 20,
      }),
      addMemory: async () => ({ project_id: 'p_1', source_id: 'n_1', queued: true }),
      removeMemory: async () => ({ project_id: 'p_1', memory_id: ID, removed: true }),
      searchMemory: async () => {
        throw new TeamApiError({ code: 'conflict', message: 'project memory is off' }, 409);
      },
    });
    expect(
      text(await client.callTool({ name: 'list_memory', arguments: { project: 'p_1' } })),
    ).toContain('search never finds it');
    expect(
      text(await client.callTool({ name: 'add_memory', arguments: { project: 'p_1', text: 'x' } })),
    ).toBe('queued n_1 for p_1');
    expect(
      text(await client.callTool({ name: 'remove_memory', arguments: { project: 'p_1', id: ID } })),
    ).toBe(`deleted ${ID}`);
    const off = await client.callTool({
      name: 'search_memory',
      arguments: { project: 'p_1', query: 'x' },
    });
    expect(off.isError).toBe(true);
    expect(text(off)).toBe('conflict: project memory is off');
  });
});
