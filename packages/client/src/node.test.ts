import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectLocal, discoverListener, listenerFilePath } from './node.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-client-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('discoverListener', () => {
  it('reads DATA/run/listener.json under AGENT_TEAM_HOME', async () => {
    const env = { AGENT_TEAM_HOME: home };
    mkdirSync(join(home, 'run'));
    const listener = { addr: 'http://127.0.0.1:4517', token: 'a'.repeat(32) };
    writeFileSync(listenerFilePath(env), JSON.stringify(listener), { mode: 0o600 });
    expect(listenerFilePath(env)).toBe(join(home, 'run', 'listener.json'));
    expect(await discoverListener({ env })).toEqual(listener);
    const client = await connectLocal({ env });
    expect(client.baseUrl).toBe('http://127.0.0.1:4517');
  });

  it('says the server is not running when the file is missing', async () => {
    await expect(discoverListener({ env: { AGENT_TEAM_HOME: home } })).rejects.toMatchObject({
      code: 'unavailable',
      hint: expect.stringMatching(/team serve/),
    });
  });

  it('rejects an invalid file', async () => {
    const env = { AGENT_TEAM_HOME: home };
    mkdirSync(join(home, 'run'));
    writeFileSync(listenerFilePath(env), '{"addr":"nope"}');
    await expect(discoverListener({ env })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the leader listener over a unix socket', () => {
  it('connectLocal talks through the socket named in the listener file (no TCP)', async () => {
    const { createServer } = await import('node:http');
    const socket = join(home, 'api.sock');
    const seen: Array<{
      method?: string;
      url?: string;
      auth?: string;
      body: string;
      key?: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        seen.push({
          ...(req.method ? { method: req.method } : {}),
          ...(req.url ? { url: req.url } : {}),
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          ...(typeof req.headers['idempotency-key'] === 'string'
            ? { key: req.headers['idempotency-key'] }
            : {}),
          body,
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ task: { id: 't_000001' } }));
      });
    });
    await new Promise<void>((ok) => server.listen(socket, ok));
    try {
      const file = join(home, 'leader.json');
      // the TCP address is unreachable on purpose: only the socket works
      writeFileSync(
        file,
        JSON.stringify({ addr: 'http://127.0.0.1:9', token: 'b'.repeat(32), socket }),
      );
      const client = await connectLocal({ env: { AGENT_TEAM_LISTENER_FILE: file } });
      const created = await client.createTask(
        { project_id: 'p_1', title: 't', tier: 'C', ticket_md: '#', owned_paths: ['a'] },
        { idempotencyKey: 'leader:msg:m_1:abc' },
      );
      expect(created).toEqual({ id: 't_000001' });
      expect(seen[0]).toMatchObject({
        method: 'POST',
        url: '/api/tasks',
        auth: `Bearer ${'b'.repeat(32)}`,
        key: 'leader:msg:m_1:abc',
      });
      expect(JSON.parse(seen[0]!.body)).toMatchObject({ title: 't' });
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
