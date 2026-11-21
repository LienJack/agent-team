import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { DATA_LAYOUT, MAX_SOCKET_PATH_BYTES, type ListenerFile } from '@agent-team/schema';

export interface Listening {
  /** Base URL with the bound port, e.g. `http://127.0.0.1:4517`. */
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

type FetchHandler = (request: Request, env: never) => Response | Promise<Response>;

async function closeServer(server: Server, graceMs: number): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** Serve `fetch` (a Hono app) on host:port (0 = ephemeral); resolves once bound. */
export async function listen(fetch: FetchHandler, host: string, port: number): Promise<Listening> {
  const server = createServer(getRequestListener(fetch as never));
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`${host}:${port} is already in use (is another agent-team running?)`)
          : err,
      );
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${bound}`,
    host,
    port: bound,
    close: () => closeServer(server, 2000),
  };
}

/**
 * Serve `fetch` on a unix socket (the leader's listener, docs/adr/0012): a stale socket from a
 * crash is replaced (anything else at the path is an error), the socket is made 0600, and
 * `close()` removes it.
 */
export async function listenUnix(
  fetch: FetchHandler,
  path: string,
): Promise<{ path: string; close(): Promise<void> }> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path too long (${Buffer.byteLength(path)} > ${MAX_SOCKET_PATH_BYTES} bytes): ${path}`,
    );
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const existing = await lstat(path).catch(() => undefined);
  if (existing && !existing.isSocket()) throw new Error(`${path} exists and is not a socket`);
  if (existing) await rm(path, { force: true });
  const server = createServer(getRequestListener(fetch as never));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      await closeServer(server, 2000);
      await rm(path, { force: true });
    },
  };
}

const WILDCARD = new Set(['0.0.0.0', '::']);

/**
 * Board URLs to print (`team serve`): `thisMachine` = the loopback address when the LAN listener
 * binds every interface (open it on this computer), `lan` = the addresses other devices use.
 */
export function boardUrls(listening: Listening): { thisMachine?: string; lan: string[] } {
  const lan = lanAddresses(listening);
  if (!WILDCARD.has(listening.host)) return { lan };
  return { thisMachine: `http://127.0.0.1:${listening.port}`, lan };
}

/** Addresses to print for a LAN listener (every IPv4 interface when bound to 0.0.0.0). */
export function lanAddresses(listening: Listening): string[] {
  if (!WILDCARD.has(listening.host)) return [listening.url];
  const urls: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${listening.port}`);
      }
    }
  }
  return urls.length > 0 ? urls : [`http://127.0.0.1:${listening.port}`];
}

/**
 * Write DATA/run/listener.json (spec §4; or `which: 'leaderListener'` → DATA/leader/listener.json
 * with the leader-scoped token) with mode 0600: any stale file is removed first, the directory
 * is 0700. CLI and MCP read it to find the local listener and its token.
 *
 * The files are protected only by Unix permissions: any process running as the same user that is
 * not sandboxed can read them (docs/adr/0014) — which is why workers run in a sandbox that
 * denies DATA.
 */
export async function writeListenerFile(
  dataDir: string,
  content: ListenerFile,
  which: 'listener' | 'leaderListener' = 'listener',
): Promise<string> {
  const path = join(dataDir, DATA_LAYOUT[which]);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { force: true });
  await writeFile(path, `${JSON.stringify(content)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return path;
}

/** Remove listener.json if it is still ours (another instance may have replaced it). */
export async function removeListenerFile(path: string, token: string): Promise<void> {
  let current: { token?: unknown };
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
  } catch {
    return;
  }
  if (current.token === token) await rm(path, { force: true });
}
