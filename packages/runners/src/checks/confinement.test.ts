import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DSH_STATE_DIR } from '../dsh/args.js';
import { dshSandboxProfile } from '../dsh/sandbox.js';
import { tempDir } from '../test-support.js';
import {
  checkSandboxAvailable,
  checkSandboxProfile,
  DOCKER_SOCKET,
  real,
  SANDBOX_EXEC,
} from './sandbox.js';

// Round 3 (docs/adr/0019): the check and dsh profiles confined files and TCP to the service
// ports only. A sandboxed process could still signal any process of the user and connect to any
// unix socket (the leader's API socket in DATA, the ssh agent, Docker). Canary processes and
// sockets OUTSIDE the sandbox prove both are closed, for both profiles.

let tmp: ReturnType<typeof tempDir>;
let canary: ChildProcess | undefined;
const servers: Array<Server | HttpServer> = [];
let launchdDir: string | undefined;

beforeEach(() => {
  // short paths: macOS limits unix-socket paths to 104 bytes
  tmp = tempDir('at-c-');
});
afterEach(async () => {
  canary?.kill('SIGKILL');
  canary = undefined;
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
  if (launchdDir) rmSync(launchdDir, { recursive: true, force: true });
  launchdDir = undefined;
  tmp.cleanup();
});

async function socketAt(path: string): Promise<void> {
  mkdirSync(join(path, '..'), { recursive: true });
  const s = createServer((c) => c.end('hit\n'));
  await new Promise<void>((ok, fail) => {
    s.once('error', fail);
    s.listen(path, ok);
  });
  servers.push(s);
}

async function tcp(): Promise<number> {
  const s = createHttpServer((_q, r) => r.end('hit'));
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  servers.push(s);
  return (s.address() as AddressInfo).port;
}

/** Runs `probe` (node) under `profile`; returns name → "ok" | error code. */
function probe(
  profile: string,
  cwd: string,
  attempts: Record<string, unknown>,
): Record<string, string> {
  const script = `
const net = require('net'); const { spawn } = require('child_process');
const attempts = ${JSON.stringify(attempts)};
const out = {};
const sock = (p) => new Promise((r) => { const c = net.connect(p); c.on('connect', () => { c.destroy(); r('ok'); }); c.on('error', (e) => r(e.code)); });
const port = (n) => new Promise((r) => { const c = net.connect(n, '127.0.0.1'); c.on('connect', () => { c.destroy(); r('ok'); }); c.on('error', (e) => r(e.code)); });
const sig = (pid, s) => { try { process.kill(pid, s); return 'ok'; } catch (e) { return e.code; } };
(async () => {
  for (const [name, a] of Object.entries(attempts)) {
    if (a.socket) out[name] = await sock(a.socket);
    else if (a.port) out[name] = await port(a.port);
    else if (a.signal) out[name] = sig(a.signal, a.with);
    else if (a.ownChild) {
      const c = spawn('/bin/sleep', ['30']);
      await new Promise((r) => c.once('spawn', r));
      out[name] = sig(c.pid, 'SIGTERM');
    } else if (a.ownGroup) {
      // what dsh and test runners do: a detached child with a grandchild, killed as a group
      const c = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
      await new Promise((r) => c.once('spawn', r));
      await new Promise((r) => setTimeout(r, 100));
      out[name] = sig(-c.pid, 'SIGTERM');
    }
  }
  console.log(JSON.stringify(out));
})();
`;
  const file = join(cwd, 'probe.cjs');
  writeFileSync(file, script);
  const r = spawnSync(SANDBOX_EXEC, ['-p', profile, process.execPath, file], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  });
  expect(r.stderr).toBe('');
  return JSON.parse(r.stdout.trim()) as Record<string, string>;
}

function layout() {
  const home = join(tmp.dir, 'h');
  const data = join(tmp.dir, 'd');
  // the worktree under home, as in ~/RanoLabs/worktrees/<project>/<task>
  const cwd = join(home, 'w');
  const logDir = join(data, 'runs', 'r_1');
  for (const d of [cwd, join(logDir, DSH_STATE_DIR), join(home, '.dsh', 'profiles', 'headless')]) {
    mkdirSync(d, { recursive: true });
  }
  return { home, data, cwd, logDir };
}

const profiles = {
  checks: (l: ReturnType<typeof layout>, ports: number[] = []) =>
    checkSandboxProfile(
      { cwd: l.cwd },
      { home: l.home, denyPaths: [l.data], servicePorts: () => ports },
    ),
  dsh: (l: ReturnType<typeof layout>, ports: number[] = [], proxyPort?: number) =>
    dshSandboxProfile(
      {
        cwd: l.cwd,
        writable: true,
        stateDir: join(l.logDir, DSH_STATE_DIR),
        patchPath: join(l.logDir, 'dsh.patch.yml'),
        dshHome: join(l.home, '.dsh'),
        proxyPort,
      },
      { home: l.home, denyPaths: [l.data], servicePorts: () => ports },
    ),
};

describe.skipIf(!checkSandboxAvailable())('process and IPC confinement (macOS Seatbelt)', () => {
  for (const name of ['checks', 'dsh'] as const) {
    it(`${name}: signals reach only the sandbox's own processes`, async () => {
      const l = layout();
      canary = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      await new Promise((ok) => canary!.once('spawn', ok));
      const out = probe(profiles[name](l), l.cwd, {
        canaryAlive: { signal: canary.pid, with: 0 },
        canaryTerm: { signal: canary.pid, with: 'SIGTERM' },
        canaryKill: { signal: canary.pid, with: 'SIGKILL' },
        serviceTerm: { signal: process.pid, with: 'SIGTERM' },
        ownChild: { ownChild: true },
        ownGroup: { ownGroup: true },
      });
      expect(out).toEqual({
        canaryAlive: 'EPERM',
        canaryTerm: 'EPERM',
        canaryKill: 'EPERM',
        serviceTerm: 'EPERM',
        ownChild: 'ok',
        ownGroup: 'ok',
      });
      expect(canary.exitCode).toBeNull();
      expect(canary.signalCode).toBeNull();
    });

    it(`${name}: no unix sockets in DATA, home, agent or container dirs; its own still work`, async () => {
      const l = layout();
      const sockets = {
        leaderApi: join(l.data, 'leader', 'api.sock'),
        docker: join(l.home, '.docker', 'run', 'd.sock'),
        orbstack: join(l.home, '.orbstack', 'run', 'd.sock'),
        gpg: join(l.home, '.gnupg', 'S.a'),
        homeOther: join(l.home, 'Library', 'x.sock'),
        tmux: join(real(tmpdir()), `tmux-${process.getuid?.() ?? 0}99`, 'default'),
        worktree: join(l.cwd, 'own.sock'),
        temp: join(mkdtempSync(join(tmpdir(), 'at-')), 'own.sock'),
      };
      launchdDir = mkdtempSync('/private/tmp/com.apple.launchd.agentteam-');
      const agent = join(launchdDir, 'Listeners');
      try {
        for (const p of [...Object.values(sockets), agent]) await socketAt(p);
        const attempts = Object.fromEntries(
          [...Object.entries(sockets), ['sshAgent', agent]].map(([k, p]) => [k, { socket: p }]),
        );
        expect(probe(profiles[name](l), l.cwd, attempts)).toEqual({
          leaderApi: 'EPERM',
          docker: 'EPERM',
          orbstack: 'EPERM',
          gpg: 'EPERM',
          homeOther: 'EPERM',
          tmux: 'EPERM',
          sshAgent: 'EPERM',
          worktree: 'ok',
          temp: 'ok',
        });
      } finally {
        rmSync(join(sockets.temp, '..'), { recursive: true, force: true });
        rmSync(join(sockets.tmux, '..'), { recursive: true, force: true });
      }
    });

    it(`${name}: the Docker socket is denied by its real path (Seatbelt matches resolved paths)`, () => {
      const profile = profiles[name](layout());
      expect(profile).toContain(`(remote unix-socket (literal "${real(DOCKER_SOCKET)}"))`);
      expect(profile).toContain('com\\.apple\\.launchd\\.');
    });
  }

  it('the control: without these rules the same canaries are reachable', async () => {
    const l = layout();
    canary = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    await new Promise((ok) => canary!.once('spawn', ok));
    const api = join(l.data, 'leader', 'api.sock');
    await socketAt(api);
    expect(
      probe('(version 1)(allow default)', l.cwd, {
        canaryAlive: { signal: canary.pid, with: 0 },
        leaderApi: { socket: api },
      }),
    ).toEqual({ canaryAlive: 'ok', leaderApi: 'ok' });
  });

  it('the model-key proxy port is open to dsh only; the service ports stay closed to both', async () => {
    const l = layout();
    const service = await tcp();
    const proxy = await tcp();
    const ports = { service: { port: service }, proxy: { port: proxy } };
    expect(probe(profiles.dsh(l, [service, proxy], proxy), l.cwd, ports)).toEqual({
      service: 'EPERM',
      proxy: 'ok',
    });
    expect(probe(profiles.checks(l, [service, proxy]), l.cwd, ports)).toEqual({
      service: 'EPERM',
      proxy: 'EPERM',
    });
  });
});
