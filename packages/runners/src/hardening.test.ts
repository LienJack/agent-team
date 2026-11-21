import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckExecutor } from './checks/executor.js';
import { claudeArgs, claudeWorkerSettings } from './claude/args.js';
import { createProcessControl, readProcessStart } from './process/control.js';
import { LineSplitter, MAX_LINE_CHARS } from './process/lines.js';
import { groupAlive, signalGroup } from './process/spawn.js';
import { eventually, makeSpec, sleep, tempDir } from './test-support.js';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

const POLICY = {
  home: '/Users/someone',
  denyPaths: ['/Users/someone/.agent-team-data', '/srv/agent-team/.env'],
};

type Settings = {
  permissions: {
    deny: string[];
    blockReadsOutsideWorkingDirectories: boolean;
    blockWritesOutsideWorkingDirectories: boolean;
  };
  sandbox: {
    enabled: boolean;
    failIfUnavailable: boolean;
    allowUnsandboxedCommands: boolean;
    excludedCommands: string[];
    filesystem: { denyRead: string[]; allowRead: string[]; denyWrite: string[] };
    network: {
      allowedDomains: string[];
      strictAllowlist: boolean;
      allowLocalBinding: boolean;
      allowAllUnixSockets: boolean;
    };
  };
};

describe('H1 claude worker sandbox settings', () => {
  it('confines a writable worker: strict sandbox, credential paths denied, no network', () => {
    const spec = makeSpec(tmp.dir, {
      sandbox: { allowNetwork: false, repoPath: '/Users/someone/src/repo' },
    });
    const s = claudeWorkerSettings(spec, POLICY) as Settings;
    expect(s.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
    });
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.permissions.blockWritesOutsideWorkingDirectories).toBe(true);
    for (const p of [
      '/Users/someone/.agent-team-data',
      '/srv/agent-team/.env',
      '/Users/someone/src/repo/.env',
      '/Users/someone/.agent-team',
      '/Users/someone/.ssh',
      '/Users/someone/.codex',
      '/Users/someone/.claude',
      '/Users/someone/.dsh',
    ]) {
      expect(s.sandbox.filesystem.denyRead).toContain(p);
      expect(s.sandbox.filesystem.denyWrite).toContain(p);
      expect(s.permissions.deny).toContain(`Read(/${p})`);
      expect(s.permissions.deny).toContain(`Read(/${p}/**)`);
      expect(s.permissions.deny).toContain(`Edit(/${p}/**)`);
    }
    // the rest of home is closed too; the worktree and the repo's git data are re-opened
    expect(s.sandbox.filesystem.denyRead).toContain('/Users/someone');
    expect(s.sandbox.filesystem.allowRead).toEqual(
      expect.arrayContaining([spec.cwd, '/Users/someone/src/repo/.git']),
    );
    expect(s.sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
      allowAllUnixSockets: false,
    });
  });

  it('allow_network opens public hosts only (local addresses stay refused by the proxy)', () => {
    const spec = makeSpec(tmp.dir, { sandbox: { allowNetwork: true } });
    const s = claudeWorkerSettings(spec, POLICY) as Settings;
    expect(s.sandbox.network.allowedDomains).toEqual(['*']);
    expect(s.sandbox.network.allowLocalBinding).toBe(false);
  });

  it('a spec without sandbox facts gets the strictest policy', () => {
    const s = claudeWorkerSettings(makeSpec(tmp.dir), POLICY) as Settings;
    expect(s.sandbox.network.allowedDomains).toEqual([]);
  });

  it('every run passes --restricted and the settings; both are required flags', () => {
    const flags = new Set(['--restricted', '--settings', '--tools', '--safe-mode']);
    for (const writable of [true, false]) {
      const spec = makeSpec(tmp.dir, { writable });
      const args = claudeArgs(spec, flags, POLICY);
      expect(args).toContain('--restricted');
      const json = args[args.indexOf('--settings') + 1]!;
      expect((JSON.parse(json) as Settings).sandbox.enabled).toBe(true);
    }
    expect(() => claudeArgs(makeSpec(tmp.dir), new Set(['--tools']), POLICY)).toThrow(/--settings/);
  });
});

/** A detached group: leader `sleep` plus one child sleeping in the same group. */
function spawnGroup(exitLeader = false): { pid: number; childPid: Promise<number> } {
  const script = exitLeader ? 'sleep 30 & echo $!; exit 0' : 'sleep 30 & echo $!; wait';
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const childPid = new Promise<number>((resolve) => {
    child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim())));
  });
  child.unref();
  return { pid: child.pid!, childPid };
}

describe('H2 process control: terminate only the recorded process', () => {
  const groups: number[] = [];
  afterEach(() => {
    for (const g of groups.splice(0)) signalGroup(g, 'SIGKILL');
  });

  it('terminates a group whose leader still has the recorded start time', async () => {
    const g = spawnGroup();
    groups.push(g.pid);
    const member = await g.childPid;
    const started = await readProcessStart(g.pid);
    expect(started).toBeTruthy();
    const res = await createProcessControl({ graceMs: 500 }).terminateGroup({
      pid: g.pid,
      startedAt: started!,
    });
    expect(res).toBe('terminated');
    expect(await eventually(() => !groupAlive(g.pid))).toBe(true);
    expect(await readProcessStart(member)).toBeUndefined();
  });

  it('never signals a pid whose start time differs (reused pid)', async () => {
    const g = spawnGroup();
    groups.push(g.pid);
    await g.childPid;
    const res = await createProcessControl().terminateGroup({
      pid: g.pid,
      startedAt: 'Thu Jan  1 00:00:00 1970',
    });
    expect(res).toBe('not_running');
    expect(groupAlive(g.pid)).toBe(true);
  });

  it('reports unconfirmed when only members of the group are left', async () => {
    const g = spawnGroup(true);
    groups.push(g.pid);
    await g.childPid;
    // the leader exits (sh after starting the background sleep); its member keeps the group
    let leaderGone = false;
    for (let i = 0; i < 100 && !leaderGone; i++) {
      leaderGone = (await readProcessStart(g.pid)) === undefined;
      if (!leaderGone) await sleep(25);
    }
    expect(leaderGone).toBe(true);
    expect(groupAlive(g.pid)).toBe(true);
    const res = await createProcessControl().terminateGroup({ pid: g.pid, startedAt: 'x' });
    expect(res).toBe('unconfirmed');
  });

  it('a pid with no process and no group is not running', async () => {
    const g = spawnGroup();
    await g.childPid;
    signalGroup(g.pid, 'SIGKILL');
    expect(await eventually(() => !groupAlive(g.pid))).toBe(true);
    expect(await createProcessControl().terminateGroup({ pid: g.pid, startedAt: 'x' })).toBe(
      'not_running',
    );
  });
});

describe('L9d line length cap', () => {
  it('truncates an endless line, marks it and keeps parsing the next lines', () => {
    const lines: string[] = [];
    const split = new LineSplitter((l) => lines.push(l));
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 8; i++) split.push(chunk); // 2 MiB without a newline
    split.push('tail-of-long\n{"type":"next"}\n');
    split.end();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 100);
    expect(lines[0]).toMatch(/…\[line truncated: \d+ more characters\]$/);
    expect(lines[1]).toBe('{"type":"next"}');
  });
});

describe('H1 machine checks run with a scrubbed environment and stop on abort', () => {
  it('passes no keys, agent socket, listener or git overrides; disables git prompts', async () => {
    const checks = createCheckExecutor({
      sourceEnv: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: tmp.dir,
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        OPENROUTER_API_KEY: 'sk-or-v1-notreal',
        ANTHROPIC_API_KEY: 'sk-ant-notreal',
        AGENT_TEAM_HOME: '/data',
        AGENT_TEAM_LISTENER_FILE: '/data/run/listener.json',
        GIT_DIR: '/elsewhere',
        TEAM_LAN_PASSWORD: 'pw-not-real',
      },
    });
    const out = await checks.run({
      cwd: join(tmp.dir, 'work'),
      name: 'env',
      cmd: '/usr/bin/env',
      logPath: join(tmp.dir, 'env.log'),
      timeoutMs: 10_000,
    });
    expect(out.passed).toBe(true);
    for (const name of [
      'SSH_AUTH_SOCK',
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'AGENT_TEAM_HOME',
      'AGENT_TEAM_LISTENER_FILE',
      'GIT_DIR',
      'TEAM_LAN_PASSWORD',
    ]) {
      expect(out.tail).not.toContain(`${name}=`);
    }
    expect(out.tail).toContain('GIT_TERMINAL_PROMPT=0');
  });

  it('an aborted check kills its group and rejects', async () => {
    const checks = createCheckExecutor({ killGraceMs: 200 });
    const ac = new AbortController();
    const pending = checks.run({
      cwd: join(tmp.dir, 'work'),
      name: 'slow',
      cmd: 'sleep 30',
      logPath: join(tmp.dir, 'slow.log'),
      timeoutMs: 60_000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
