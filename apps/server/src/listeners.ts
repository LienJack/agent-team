import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { DATA_LAYOUT, type ListenerFile } from '@agent-team/schema';

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

/** Addresses to print for a LAN listener (every IPv4 interface when bound to 0.0.0.0). */
export function lanAddresses(listening: Listening): string[] {
  if (listening.host !== '0.0.0.0' && listening.host !== '::') return [listening.url];
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
 * Write DATA/run/listener.json (spec §4) with mode 0600: any stale file is removed first, the
 * directory is 0700. CLI and MCP read it to find the local listener and its token.
 */
export async function writeListenerFile(dataDir: string, content: ListenerFile): Promise<string> {
  const path = join(dataDir, DATA_LAYOUT.listener);
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
