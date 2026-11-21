#!/usr/bin/env node
// `pnpm start`: build what is missing or out of date, then run the server from dist/ in the
// foreground (the same process `team serve` starts). Ctrl-C reaches the server through the
// terminal's process group; SIGTERM is forwarded. Exits with the server's exit code.
//
//   - TypeScript: `tsc -b` (incremental: a no-op when every package is up to date)
//   - the board: `vite build` when apps/web/dist is missing or older than its sources
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Newest mtime (ms) under `path` (files only; node_modules and dist skipped). */
export function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

/** True when the built board is missing or older than anything it is built from. */
export function boardIsStale(webDir) {
  const built = join(webDir, 'dist', 'index.html');
  if (!existsSync(built)) return true;
  const sources = ['src', 'public', 'index.html', 'vite.config.ts'].map((p) =>
    newestMtime(join(webDir, p)),
  );
  return Math.max(...sources) > statSync(built).mtimeMs;
}

function run(args, what) {
  process.stderr.write(`agent-team: ${what}…\n`);
  const result = spawnSync(pnpm, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`agent-team: ${what} failed\n`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  run(['exec', 'tsc', '-b'], 'building the packages (tsc -b)');
  const webDir = join(root, 'apps', 'web');
  if (boardIsStale(webDir)) run(['--filter', '@agent-team/web', 'build'], 'building the board');

  const entry = join(root, 'apps', 'server', 'dist', 'main.js');
  if (!existsSync(entry)) {
    process.stderr.write(`agent-team: ${entry} is missing after the build\n`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
  const onTerm = () => child.kill('SIGTERM');
  process.on('SIGTERM', onTerm);
  // Ctrl-C already reached the server (same process group); do not exit before it has stopped
  process.on('SIGINT', () => {});
  child.once('exit', (code, signal) => {
    process.off('SIGTERM', onTerm);
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
