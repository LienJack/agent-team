import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModelKeyProxy, RUN_TOKEN_PREFIX, type ModelKeyProxy } from './model-proxy.js';

// docs/adr/0020: the key proxy is the only holder of the real key; dsh gets a per-run token. A
// fake upstream on loopback stands in for OpenRouter (no network in tests).

const KEY = 'sk-or-v1-fake-test-key-0000000000000000';
const PATH = '/api/v1/chat/completions';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upstreamPort = 0;
let seen: Seen[] = [];
let respond: (res: ServerResponse, req: Seen) => void;
let proxy: ModelKeyProxy;
let key: string | undefined;
let logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;

const logger = {
  debug: (message: string, fields?: Record<string, unknown>) =>
    logs.push({ level: 'debug', message, ...(fields ? { fields } : {}) }),
  info: (message: string, fields?: Record<string, unknown>) =>
    logs.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
  warn: (message: string, fields?: Record<string, unknown>) =>
    logs.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
  error: (message: string, fields?: Record<string, unknown>) =>
    logs.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
};

beforeEach(async () => {
  seen = [];
  logs = [];
  key = KEY;
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(s);
      respond(res, s);
    });
  });
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
  upstreamPort = (upstream.address() as AddressInfo).port;
  proxy = createModelKeyProxy({
    key: () => key,
    logger,
    upstreamForTests: `http://127.0.0.1:${upstreamPort}`,
  });
  await proxy.start();
});

afterEach(async () => {
  await proxy.close();
  upstream.closeAllConnections();
  await new Promise<void>((ok) => upstream.close(() => ok()));
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function call(
  opts: { method?: string; path?: string; token?: string; headers?: Record<string, string> },
  body = '{"model":"m","stream":true}',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: opts.method ?? 'POST',
        path: opts.path ?? PATH,
        headers: {
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('model-key proxy (docs/adr/0020)', () => {
  it('swaps a live run token for the real key and forwards only the allow-listed endpoint', async () => {
    const lease = proxy.open('d_1')!;
    expect(lease.token.startsWith(RUN_TOKEN_PREFIX)).toBe(true);
    expect(lease.token).not.toContain(KEY);
    expect(lease.baseUrl).toBe(`http://127.0.0.1:${proxy.port}/api/v1`);
    const r = await call({
      token: lease.token,
      headers: { cookie: 'c=1', 'x-api-key': 'leak', 'x-session-id': 's1', 'x-title': 'dsh' },
    });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('{"ok":true}');
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s).toMatchObject({ method: 'POST', url: PATH, body: '{"model":"m","stream":true}' });
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    expect(s.headers['x-session-id']).toBe('s1');
    expect(s.headers['x-title']).toBe('dsh');
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(s.headers)).not.toContain(lease.token);
  });

  it('refuses everything else without reaching the upstream', async () => {
    const lease = proxy.open('d_1')!;
    const refused = await Promise.all([
      call({}), // no token
      call({ token: `${RUN_TOKEN_PREFIX}${'x'.repeat(43)}` }), // unknown token
      call({ token: KEY }), // the real key itself is not a run token
      call({ token: lease.token, path: '/api/v1/models' }),
      call({ token: lease.token, path: '/api/v1/auth/keys' }),
      call({ token: lease.token, path: `${PATH}?x=1` }),
      call({ token: lease.token, path: `${PATH}/` }),
      call({ token: lease.token, path: `http://evil.example${PATH}` }),
      call({ token: lease.token, method: 'GET' }),
      call({ token: lease.token, method: 'PUT' }),
    ]);
    expect(refused.map((r) => r.status)).toEqual([
      401, 401, 401, 404, 404, 404, 404, 404, 404, 404,
    ]);
    expect(seen).toHaveLength(0);
  });

  it('streams the answer through as it arrives (SSE)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((ok) => (release = ok));
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
      void gate.then(() => res.end('data: [DONE]\n\n'));
    };
    const lease = proxy.open('d_1')!;
    const first = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: PATH,
          headers: { authorization: `Bearer ${lease.token}` },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.once('data', (c: Buffer) => {
            // the first event arrived while the upstream still holds the stream open
            resolve(c.toString());
            release();
          });
          res.resume();
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(first).toBe('data: {"n":1}\n\n');
  });

  it('passes compressed bodies through untouched', async () => {
    const gz = gzipSync(Buffer.from('{"compressed":true}'));
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gz);
    };
    const r = await call({
      token: proxy.open('d_1')!.token,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(seen[0]!.headers['accept-encoding']).toBe('gzip');
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.body.equals(gz)).toBe(true);
  });

  it('a revoked token is refused and its in-flight exchange is aborted', async () => {
    const lease = proxy.open('d_1')!;
    let upstreamClosed = false;
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n'); // never ends by itself
      res.on('close', () => (upstreamClosed = true));
    };
    const ended = new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: PATH,
          headers: { authorization: `Bearer ${lease.token}` },
        },
        (res) => {
          res.once('data', () => lease.revoke());
          res.on('close', () => resolve());
          res.on('error', () => resolve());
          res.resume();
        },
      );
      req.on('error', () => resolve());
      req.end('{}');
    });
    await ended;
    expect(proxy.liveTokens()).toBe(0);
    await expect.poll(() => upstreamClosed).toBe(true);
    expect((await call({ token: lease.token })).status).toBe(401);
    lease.revoke(); // idempotent
  });

  it('without a key it answers 503 and reports hasKey false; open() needs a running proxy', async () => {
    key = undefined;
    expect(proxy.hasKey()).toBe(false);
    expect((await call({ token: proxy.open('d_1')!.token })).status).toBe(503);
    expect(seen).toHaveLength(0);
    key = KEY;
    expect(proxy.hasKey()).toBe(true);
    const idle = createModelKeyProxy({ key: () => KEY, logger });
    expect(idle.open('d_2')).toBeUndefined();
    await idle.close();
  });

  it('an upstream failure is a 502 without details; tokens and keys never reach the logs', async () => {
    const lease = proxy.open('d_1')!;
    respond = (res) => res.socket?.destroy();
    const r = await call({ token: lease.token }, '{"secret prompt":"body text"}');
    expect(r.status).toBe(502);
    expect(r.body.toString()).not.toContain(KEY);
    await call({ token: 'nope-nope-nope-nope' });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(lease.token);
    expect(text).not.toContain('secret prompt');
    expect(text).not.toMatch(/authorization/i);
  });

  it('CONNECT tunnels are closed and the upstream sees nothing', async () => {
    const lease = proxy.open('d_1')!;
    const reply = await new Promise<string>((resolve) => {
      const sock = connect(proxy.port!, '127.0.0.1', () => {
        sock.write(
          `CONNECT openrouter.ai:443 HTTP/1.1\r\nHost: openrouter.ai:443\r\nAuthorization: Bearer ${lease.token}\r\n\r\n`,
        );
      });
      let out = '';
      sock.on('data', (d: Buffer) => (out += d.toString()));
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out));
    });
    expect(reply).not.toMatch(/^HTTP\/1\.1 200/);
    expect(seen).toHaveLength(0);
  });

  it('only a loopback upstream may replace the fixed one (tests)', () => {
    expect(() =>
      createModelKeyProxy({ key: () => KEY, logger, upstreamForTests: 'http://evil.example' }),
    ).toThrow(/127\.0\.0\.1/);
  });
});
