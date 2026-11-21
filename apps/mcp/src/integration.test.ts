import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectLocal } from '@agent-team/client/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real server in-process over HTTP (apps may not import each other: the harness is loaded by a
// runtime-resolved path, as in apps/cli) and the MCP server as a child process over stdio.
interface ServerHarness {
  service: { start(): Promise<unknown>; stop(): Promise<void> };
  dataDir: string;
  cleanup(): Promise<void>;
}
const harnessPath = fileURLToPath(new URL('../../server/src/testing/harness.ts', import.meta.url));
const binPath = fileURLToPath(new URL('./bin.ts', import.meta.url));

let server: ServerHarness;
let mcp: Client;
let transport: StdioClientTransport;

const text = (r: unknown) =>
  ((r as { content: unknown }).content as Array<{ type: string; text: string }>)[0]!.text;

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(harnessPath).href)) as {
    createTestService(): ServerHarness;
  };
  server = mod.createTestService();
  await server.service.start();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=@agent-team/source', '--import', 'tsx', binPath],
    env: {
      PATH: process.env['PATH'] ?? '',
      AGENT_TEAM_HOME: server.dataDir,
      AGENT_TEAM_FAKE_RUNNERS: '1',
    },
    stderr: 'ignore',
  });
  mcp = new Client({ name: 'integration', version: '0' });
  await mcp.connect(transport);
}, 30_000);

afterAll(async () => {
  await mcp?.close();
  await server?.cleanup();
});

describe('MCP server over stdio against the real HTTP server', () => {
  it('lists tools, reports status, and answers an attention item', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'answer_attention',
      'ask_leader',
      'list_attention',
      'status',
      'task_action',
    ]);

    const status = await mcp.callTool({ name: 'status', arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(text(status)).toMatch(/^board: pending 0 · in_progress 0/);
    expect(text(status)).toContain('attention: 0 open');

    const http = await connectLocal({ env: { AGENT_TEAM_HOME: server.dataDir } });
    const item = await http.openAttention({ question: 'Which db?', options: ['sqlite', 'pg'] });

    const listed = await mcp.callTool({ name: 'list_attention', arguments: {} });
    expect(text(listed)).toContain(item.id);
    expect(text(listed)).toContain('sqlite | pg');

    const answered = await mcp.callTool({
      name: 'answer_attention',
      arguments: { id: item.id, answer: 'sqlite' },
    });
    expect(answered.isError).toBeFalsy();
    expect(text(answered)).toBe(`${item.id} answered: sqlite`);

    const after = await http.listAttention({ status: 'answered' });
    expect(after).toMatchObject([{ id: item.id, answer: 'sqlite', answered_via: 'mcp' }]);

    const missing = await mcp.callTool({
      name: 'answer_attention',
      arguments: { id: 'a_doesnotexist', answer: 'x' },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^not_found: /);
  }, 30_000);

  it('exits cleanly when stdin closes and keeps stdout protocol-only', async () => {
    const child = spawn(
      process.execPath,
      ['--conditions=@agent-team/source', '--import', 'tsx', binPath],
      { env: { PATH: process.env['PATH'] ?? '', AGENT_TEAM_HOME: server.dataDir } },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    await new Promise((r) => setTimeout(r, 1500));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(out).toBe('');
  }, 30_000);
});
