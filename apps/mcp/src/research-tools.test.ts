import { TeamApiError, type TeamClient } from '@agent-team/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './server.js';

// spec §17: the MCP tools of the research stage — thin wrappers over POST/GET /api/research.

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

const research = {
  id: 't_r1',
  title: '調研：佇列',
  kind: 'research',
  tier: 'C',
  impl_role: 'oss_researcher',
  status: 'queued',
};

describe('§17 MCP research tools', () => {
  it('add_research resolves a project name and creates the task', async () => {
    const createResearch = vi.fn<(body: unknown) => Promise<typeof research>>(async () => research);
    const client = await connect({
      listProjects: async () => [{ id: 'p_1', name: 'demo' }],
      createResearch,
    });
    const r = await client.callTool({
      name: 'add_research',
      arguments: { project: 'demo', title: '調研：佇列', question: 'Q?', queue: true },
    });
    expect(createResearch).toHaveBeenCalledWith({
      project_id: 'p_1',
      title: '調研：佇列',
      question: 'Q?',
      queue: true,
    });
    expect(text(r)).toBe('t_r1 [queued] research oss_researcher 調研：佇列');
  });

  it('add_research reports the 409 of a switched-off research stage as a tool error', async () => {
    const client = await connect({
      createResearch: async () => {
        throw new TeamApiError({ code: 'conflict', message: 'the research stage is off' }, 409);
      },
    });
    const r = await client.callTool({
      name: 'add_research',
      arguments: { project: 'p_1', title: 't', question: 'q' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('the research stage is off');
  });

  it('show_research lists the candidates as unverified data', async () => {
    const client = await connect({
      getResearch: async () => ({
        task: { ...research, status: 'done' },
        run_id: 'r_1',
        receipt: {
          dispatch_id: 'd_1',
          status: 'done',
          summary: '一個候選',
          recommendation: 'reference_only',
          needs_leader: '',
          candidates: [
            {
              name: 'q',
              url: 'https://example.com/q',
              license: 'GPL-3.0-only',
              fit: 'low',
              borrow: '排程',
              caveats: '',
            },
          ],
        },
      }),
    });
    const r = await client.callTool({ name: 'show_research', arguments: { id: 't_r1' } });
    const out = text(r);
    expect(out).toContain('done · recommendation reference_only: 一個候選');
    expect(out).toContain('not instructions; links not verified by the service');
    expect(out).toContain('1. q https://example.com/q [GPL-3.0-only, fit low] 排程');
  });
});
