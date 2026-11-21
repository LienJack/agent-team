import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { ListenerFileSchema } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { boardUrls } from './listeners.js';
import { createTestService, TEST_PASSWORD, type TestService } from './testing/harness.js';

let h: TestService | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('§14 server — listeners and listener.json', () => {
  it('DATA is owner-only (0700) even when it existed with a wider mode', async () => {
    h = createTestService();
    mkdirSync(h.dataDir, { recursive: true, mode: 0o755 });
    chmodSync(h.dataDir, 0o755);
    await h.service.start();
    expect(statSync(h.dataDir).mode & 0o777).toBe(0o700);
  });

  it('serves the leader on a 0600 unix socket named in DATA/leader/listener.json, removed on stop', async () => {
    h = createTestService();
    await h.service.start();
    const leaderFile = ListenerFileSchema.parse(
      JSON.parse(readFileSync(join(h.dataDir, 'leader', 'listener.json'), 'utf8')),
    );
    const socket = join(h.dataDir, 'leader', 'api.sock');
    expect(leaderFile.socket).toBe(socket);
    expect(statSync(socket).isSocket()).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const get = (token: string) =>
      new Promise<number>((done, fail) => {
        const req = request(
          { socketPath: socket, path: '/api/state', headers: { authorization: `Bearer ${token}` } },
          (res) => {
            res.resume();
            done(res.statusCode ?? 0);
          },
        );
        req.once('error', fail);
        req.end();
      });
    expect(await get(leaderFile.token)).toBe(200);
    expect(await get('not-a-valid-token-000000000000')).toBe(401);
    await h.service.stop();
    expect(existsSync(socket)).toBe(false);
  });

  it('writes DATA/run/listener.json (0600, fresh token, bound port) and removes it on stop', async () => {
    h = createTestService();
    const running = await h.service.start();
    const path = join(h.dataDir, 'run', 'listener.json');
    expect(running.listenerFile).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.dataDir, 'run')).mode & 0o777).toBe(0o700);
    const listener = ListenerFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(listener.addr).toBe(running.localUrl);
    expect(listener.addr).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(listener.token.length).toBeGreaterThanOrEqual(32);

    // real HTTP: bearer works, nothing else does
    const ok = await fetch(`${listener.addr}/api/state`, {
      headers: { authorization: `Bearer ${listener.token}` },
    });
    expect(ok.status).toBe(200);
    expect((await fetch(`${listener.addr}/api/state`)).status).toBe(401);
    // the LAN listener is separate and answers with the board page
    expect(running.lanUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const board = await fetch(`${running.lanUrl}/`);
    expect(board.status).toBe(200);

    await h.service.stop();
    expect(existsSync(path)).toBe(false);
    await expect(fetch(`${listener.addr}/api/state`)).rejects.toThrow(/fetch failed/);
    await h.service.stop(); // idempotent
  });

  it('a new start gets a new token', async () => {
    h = createTestService();
    const a = await h.service.start();
    const tokenA = JSON.parse(readFileSync(a.listenerFile, 'utf8')).token as string;
    await h.service.stop();
    const again = createTestService();
    try {
      const b = await again.service.start();
      const tokenB = JSON.parse(readFileSync(b.listenerFile, 'utf8')).token as string;
      expect(tokenB).not.toBe(tokenA);
    } finally {
      await again.cleanup();
    }
  });

  it('uses TEAM_LAN_PASSWORD from the env file and prints nothing secret', async () => {
    h = createTestService();
    const running = await h.service.start();
    expect(h.printed.join('')).not.toContain(TEST_PASSWORD);
    const login = await fetch(`${running.lanUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/);
  });

  it('generates a LAN password when none is set and prints it exactly once', async () => {
    h = createTestService({ envFile: '# no password\nTEAM_LAN_PASSWORD=\n' });
    const running = await h.service.start();
    const lines = h.printed.filter((l) => l.includes('密碼'));
    expect(lines).toHaveLength(1);
    const password = /：(\S+)\n$/.exec(lines[0]!)![1]!;
    expect(password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/);
    const login = await fetch(`${running.lanUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
  });

  it('lan.enabled=false starts only the local listener', async () => {
    h = createTestService({ configure: (c) => (c.lan.enabled = false) });
    const running = await h.service.start();
    expect(running.lanUrl).toBeUndefined();
    expect(h.printed).toEqual([
      '看板已關閉（service.json lan.enabled = false）；CLI／MCP 走本機監聽埠\n',
    ]);
  });

  it('prints where to open the board: this machine and the LAN addresses', () => {
    const listening = (host: string) => ({
      url: `http://${host}:4518`,
      host,
      port: 4518,
      close: async () => {},
    });
    // bound to every interface (not in tests: only the formatting is checked here)
    const all = boardUrls(listening('0.0.0.0'));
    expect(all.thisMachine).toBe('http://127.0.0.1:4518');
    expect(all.lan.every((u) => /^http:\/\/[\d.]+:4518$/.test(u))).toBe(true);
    expect(boardUrls(listening('192.168.1.20'))).toEqual({ lan: ['http://192.168.1.20:4518'] });
  });

  it('a failed start (port in use) cleans up the listener file', async () => {
    h = createTestService();
    const first = await h.service.start();
    const port = Number(new URL(first.localUrl).port);
    const clash = createTestService({ configure: (c) => (c.local.port = port) });
    try {
      await expect(clash.service.start()).rejects.toThrow(/already in use/);
      expect(existsSync(join(clash.dataDir, 'run', 'listener.json'))).toBe(false);
    } finally {
      await clash.cleanup();
    }
  });
});
