import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test-support.js';
import { createCheckExecutor } from './executor.js';
import { checkSandboxAvailable } from './sandbox.js';

// H1 residual closed where the platform allows: machine checks run worker-authored code, so on
// macOS they run under Seatbelt with the workers' deny list (docs/adr/0014).

let tmp: ReturnType<typeof tempDir>;
let server: Server;
let other: Server;
let port = 0;
let otherPort = 0;
let hits = 0;
beforeEach(async () => {
  tmp = tempDir();
  for (const d of ['home/.ssh', 'data/run', 'work', 'repo/.git/hooks']) {
    mkdirSync(join(tmp.dir, d), { recursive: true });
  }
  writeFileSync(join(tmp.dir, 'data/run/listener.json'), '{"token":"t"}\n');
  writeFileSync(join(tmp.dir, 'home/.ssh/id'), 'key\n');
  hits = 0;
  server = createServer((_q, r) => {
    hits++;
    r.end('hit');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
  // a test server of the project itself (checks that start local servers must keep working)
  other = createServer((_q, r) => r.end('own'));
  await new Promise<void>((ok) => other.listen(0, '127.0.0.1', ok));
  otherPort = (other.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await new Promise<void>((ok) => other.close(() => ok()));
  tmp.cleanup();
});

const node = JSON.stringify(process.execPath);

function script(): string {
  const listener = JSON.stringify(join(tmp.dir, 'data/run/listener.json'));
  const key = JSON.stringify(join(tmp.dir, 'home/.ssh/id'));
  const hook = JSON.stringify(join(tmp.dir, 'repo/.git/hooks/pre-commit'));
  const rc = JSON.stringify(join(tmp.dir, 'home/.zshrc'));
  return `const fs = require('fs');
const tryIt = (n, f) => { try { f(); console.log(n + ' ok'); } catch (e) { console.log(n + ' denied ' + e.code); } };
tryIt('listener', () => fs.readFileSync(${listener}));
tryIt('sshkey', () => fs.readFileSync(${key}));
tryIt('hook', () => fs.writeFileSync(${hook}, 'x'));
tryIt('rc', () => fs.writeFileSync(${rc}, 'x'));
tryIt('worktree', () => fs.writeFileSync('out.txt', 'x'));
fetch('http://127.0.0.1:${port}/').then(() => console.log('loopback ok'), (e) => console.log('loopback denied ' + (e.cause && e.cause.code)));
fetch('http://127.0.0.1:${otherPort}/').then((r) => r.text()).then((t) => console.log('own server ' + t), (e) => console.log('own server denied ' + (e.cause && e.cause.code)));
`;
}

describe.skipIf(!checkSandboxAvailable())('H1 machine checks under Seatbelt (macOS)', () => {
  it('denies the deny list, writes outside the worktree and the service ports', async () => {
    writeFileSync(join(tmp.dir, 'work', 'probe.cjs'), script());
    const checks = createCheckExecutor({
      sandbox: {
        home: join(tmp.dir, 'home'),
        denyPaths: [join(tmp.dir, 'data')],
        servicePorts: () => [port],
      },
    });
    const out = await checks.run({
      cwd: join(tmp.dir, 'work'),
      repoPath: join(tmp.dir, 'repo'),
      name: 'probe',
      cmd: `${node} probe.cjs`,
      logPath: join(tmp.dir, 'probe.log'),
      timeoutMs: 20_000,
    });
    expect(out.tail).toContain('listener denied');
    expect(out.tail).toContain('sshkey denied');
    expect(out.tail).toContain('hook denied');
    expect(out.tail).toContain('rc denied');
    expect(out.tail).toContain('worktree ok');
    expect(out.tail).toMatch(/loopback denied/);
    expect(out.tail).toContain('own server own'); // other loopback ports stay usable
    expect(hits).toBe(0);
  });

  it('git works in a sandboxed check although ~/.gitconfig is denied', async () => {
    const home = join(tmp.dir, 'home');
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = someone\n');
    const work = join(tmp.dir, 'work');
    execFileSync('git', ['init', '-q'], {
      cwd: work,
      env: { PATH: process.env['PATH']!, HOME: home },
    });
    writeFileSync(join(work, 'a.txt'), 'a\n');
    const checks = createCheckExecutor({
      sourceEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home },
      sandbox: { home, denyPaths: [join(tmp.dir, 'data')] },
    });
    const out = await checks.run({
      cwd: work,
      name: 'git',
      cmd: 'git status --short',
      logPath: join(tmp.dir, 'git.log'),
      timeoutMs: 20_000,
    });
    expect(out.tail).not.toMatch(/fatal/);
    expect(out).toMatchObject({ passed: true });
    expect(out.tail).toContain('?? a.txt');
  });

  it('without a policy the same check can do all of it (the control)', async () => {
    writeFileSync(join(tmp.dir, 'work', 'probe.cjs'), script());
    const out = await createCheckExecutor().run({
      cwd: join(tmp.dir, 'work'),
      name: 'probe',
      cmd: `${node} probe.cjs`,
      logPath: join(tmp.dir, 'probe.log'),
      timeoutMs: 20_000,
    });
    expect(out.tail).toContain('listener ok');
    expect(out.tail).toContain('loopback ok');
  });
});
