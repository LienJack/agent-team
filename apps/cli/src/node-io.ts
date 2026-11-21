import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectLocal } from '@agent-team/client/node';
import { UsageError, type CliIo } from './io.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The server's entry: `AGENT_TEAM_SERVER_ENTRY`, else the built `apps/server/dist/main.js` next
 * to this package (the CLI may not import the server; it starts it as a process).
 */
export function serverEntry(env: Env): string {
  const override = env['AGENT_TEAM_SERVER_ENTRY'];
  if (override !== undefined && override !== '') return resolve(override);
  return fileURLToPath(new URL('../../server/dist/main.js', import.meta.url));
}

/** `team serve`: run the server in the foreground and return its exit code. */
export function runServer(env: Env): Promise<number> {
  const entry = serverEntry(env);
  if (!existsSync(entry)) {
    throw new UsageError(
      `server entry ${entry} not found: run \`pnpm build\` first (or set AGENT_TEAM_SERVER_ENTRY)`,
    );
  }
  const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: { ...env } });
  // Ctrl-C reaches the child through the terminal's process group; only forward SIGTERM
  // (forwarding SIGINT too would count as a second signal and force-exit the server)
  const onTerm = () => child.kill('SIGTERM');
  process.on('SIGTERM', onTerm);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      process.off('SIGTERM', onTerm);
      done(code ?? (signal ? 1 : 0));
    });
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The real process IO: stdout/stderr, listener.json discovery, Ctrl-C as an abort signal. */
export function nodeIo(signal: AbortSignal): CliIo {
  const env = process.env;
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    readStdin: () => readAll(process.stdin),
    readFile: (path) => readFile(path, 'utf8'),
    cwd: process.cwd(),
    env,
    connect: () =>
      connectLocal({ env, ...(env['AGENT_TEAM_ACTOR'] === 'leader' ? { actor: 'leader' } : {}) }),
    serve: () => runServer(env),
    signal,
  };
}
