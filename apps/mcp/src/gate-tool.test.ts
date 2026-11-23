import type { TeamClient } from '@agent-team/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';

// spec §19: gate_worktree is a thin wrapper that waits for the gate job's verdict.

const clients: Client[] = [];
async function connect(fake: Record<string, unknown>) {
  const server = createServer(async () => fake as unknown as TeamClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('§19 MCP gate_worktree', () => {
  it('starts the job, waits for done and reports verdict, files and checks', async () => {
    const bodies: unknown[] = [];
    const client = await connect({
      listProjects: async () => [{ id: 'p_1', name: 'demo' }],
      startGate: async (body: unknown) => {
        bodies.push(body);
        return { gate_id: 'g_1', state: 'running' };
      },
      getGate: async () => ({
        gate_id: 'g_1',
        project_id: 'p_1',
        worktree_path: '/w',
        state: 'done',
        verdict: 'checks_failed',
        reasons: ['checks not passed: test'],
        files_changed: ['src/a.ts'],
        out_of_scope: [],
        checks: [{ name: 'test', cmd: 'pnpm test', result: 'fail', tail: 'FAIL' }],
        committed: false,
        head_sha: 'c'.repeat(40),
        started_at: '2026-11-23T00:00:00.000Z',
        ended_at: '2026-11-23T00:00:01.000Z',
      }),
    });
    const r = (await client.callTool({
      name: 'gate_worktree',
      arguments: {
        project: 'demo',
        worktree_path: '/w',
        base_sha: 'ABCDEF12',
        owned_paths: ['src/'],
      },
    })) as { content: Array<{ text: string }>; structuredContent: unknown; isError?: boolean };
    expect(r.isError).toBeUndefined();
    expect(bodies).toEqual([
      {
        project_id: 'p_1',
        worktree_path: '/w',
        base_sha: 'abcdef12',
        owned_paths: ['src/'],
        commit: true,
      },
    ]);
    expect(r.content[0]!.text).toContain('g_1 checks_failed');
    expect(r.content[0]!.text).toContain('check test: fail');
    expect(r.structuredContent).toMatchObject({ gate_id: 'g_1', verdict: 'checks_failed' });
  });
});
