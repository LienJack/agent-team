import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@agent-team/core';
import type { ModelKeyBroker, ModelKeyLease } from '@agent-team/runners';

// The model-key proxy (docs/adr/0020). Any same-user process can read another process's exec
// environment (`sysctl KERN_PROCARGS2`; Seatbelt does not stop it), so the real OpenRouter key
// must not be in any child's environment. The server — the only reader of `.env` — keeps it and
// runs this proxy on 127.0.0.1: each dsh run gets a random token and the proxy's base URL; the
// proxy accepts only live run tokens, forwards only the allow-listed endpoint to the fixed
// upstream over TLS, swaps the token for the real key and streams the answer back. It never logs
// headers or bodies.

/** The only upstream in production (TLS, the default CA store; no environment proxy). */
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
/** The base path dsh is pointed at; the token never leaves loopback. */
export const PROXY_BASE_PATH = '/api/v1';
/** What dsh 0.2.1-rc.5's OpenRouter route sends (pi-ai `openai-completions`). POST only. */
export const PROXY_PATHS: readonly string[] = [`${PROXY_BASE_PATH}/chat/completions`];
/** Run tokens look like this (redact patterns in `@agent-team/schema` know the prefix). */
export const RUN_TOKEN_PREFIX = 'at-run-';

/** Request headers never forwarded: hop-by-hop, routing, and every credential slot. */
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

export interface ModelKeyProxyOptions {
  /** The real key, read per request (the server's env reader; a `.env` edit applies at once). */
  key: () => string | undefined;
  logger: Logger;
  /**
   * Tests only: a fake upstream on loopback (`http://127.0.0.1:<port>`). Production never sets
   * it: the upstream is `OPENROUTER_ORIGIN`.
   */
  upstreamForTests?: string;
  /** Idle timeout of one upstream exchange (default 10 minutes; streams send keep-alives). */
  upstreamTimeoutMs?: number;
}

export interface ModelKeyProxy extends ModelKeyBroker {
  /** Bind 127.0.0.1 on an ephemeral port. */
  start(): Promise<{ port: number }>;
  /** Stop accepting, abort what is in flight, forget every token. */
  close(): Promise<void>;
  readonly port: number | undefined;
  /** Number of live tokens (tests, diagnostics). */
  liveTokens(): number;
}

interface Lease {
  runId: string;
  inflight: Set<ClientRequest>;
}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function forwardable(headers: IncomingHttpHeaders, drop: ReadonlySet<string>): OutgoingHttpHeaders {
  // names listed in `Connection` are hop-by-hop too
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || drop.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return; // the client is gone (or the run was revoked)
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({
    error: { message: `agent-team model proxy: ${message}`, code: status },
  });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createModelKeyProxy(opts: ModelKeyProxyOptions): ModelKeyProxy {
  const upstream = new URL(opts.upstreamForTests ?? OPENROUTER_ORIGIN);
  if (opts.upstreamForTests !== undefined && upstream.hostname !== '127.0.0.1') {
    throw new Error('the test upstream must be on 127.0.0.1');
  }
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const timeoutMs = opts.upstreamTimeoutMs ?? 600_000;
  const leases = new Map<string, Lease>();
  let port: number | undefined;

  function lookup(req: IncomingMessage): Lease | undefined {
    const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(req.headers.authorization ?? '');
    return m ? leases.get(digest(m[1]!)) : undefined;
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // exact origin-form path, POST only: no query, no absolute-form target, nothing else
    if (req.method !== 'POST' || req.url === undefined || !PROXY_PATHS.includes(req.url)) {
      req.resume();
      return sendError(res, 404, 'not an allowed endpoint');
    }
    const lease = lookup(req);
    if (!lease) {
      req.resume();
      return sendError(res, 401, 'missing, unknown or expired run token');
    }
    const key = opts.key();
    if (key === undefined || key.trim() === '') {
      req.resume();
      return sendError(res, 503, 'OPENROUTER_API_KEY is not set');
    }
    const headers = forwardable(req.headers, DROP_REQUEST);
    headers.authorization = `Bearer ${key}`;
    headers.host = upstream.host;
    const started = Date.now();
    const up = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port === '' ? undefined : Number(upstream.port),
        method: 'POST',
        path: req.url,
        headers,
        timeout: timeoutMs,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, forwardable(upRes.headers, DROP_RESPONSE));
        // streaming passthrough: bytes as they arrive (SSE), compressed bodies untouched
        upRes.pipe(res);
        upRes.on('end', () =>
          opts.logger.debug('model proxy exchange', {
            run: lease.runId,
            status: upRes.statusCode ?? null,
            ms: Date.now() - started,
          }),
        );
      },
    );
    lease.inflight.add(up);
    up.on('close', () => lease.inflight.delete(up));
    up.on('timeout', () => up.destroy(new Error('upstream timed out')));
    up.on('error', (err: NodeJS.ErrnoException) => {
      // the code only: an error message could quote a request
      opts.logger.warn('model proxy upstream failed', { run: lease.runId, code: err.code ?? null });
      sendError(res, 502, `upstream unavailable (${err.code ?? 'error'})`);
    });
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  }

  const server = createServer(handle);
  // CONNECT and upgrades have no handler: node closes those sockets (no tunnelling)
  server.on('clientError', (_err, socket) => socket.destroy());

  function revoke(digestKey: string): void {
    const lease = leases.get(digestKey);
    if (!lease) return;
    leases.delete(digestKey);
    for (const up of lease.inflight) up.destroy(new Error('run token revoked'));
  }

  return {
    get port() {
      return port;
    },
    hasKey: () => {
      const key = opts.key();
      return key !== undefined && key.trim() !== '';
    },
    open(runId: string): ModelKeyLease | undefined {
      if (port === undefined) return undefined;
      const token = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const d = digest(token);
      leases.set(d, { runId, inflight: new Set() });
      return {
        token,
        port,
        baseUrl: `http://127.0.0.1:${port}${PROXY_BASE_PATH}`,
        revoke: () => revoke(d),
      };
    },
    liveTokens: () => leases.size,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      port = (server.address() as AddressInfo).port;
      opts.logger.info('model-key proxy listening', { port });
      return { port };
    },
    async close() {
      for (const d of Array.from(leases.keys())) revoke(d);
      port = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
