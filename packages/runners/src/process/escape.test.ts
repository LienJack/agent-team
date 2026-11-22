import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventually, sleep, tempDir } from '../test-support.js';
import { createProcessControl, readProcessStart } from './control.js';
import { runChild } from './spawn.js';

// docs/adr/0022 §4 with real, short-lived processes (never a model): descendants that leave the
// worker's process group — a setsid() child, a double-forked daemon — on timeout, cancel (also
// what a shutdown does: it aborts the run), a normal exit and crash recovery. Before this change
// the group kill left both alive in every case; now they go when they provably belong to the run,
// and processes that do not are left alone.

const IDLE = 'setInterval(() => {}, 1000)';

/**
 * A worker: a child in its group, a setsid() child, a daemon (an intermediate that setsid()s a
 * grandchild and exits at once), each writing its pid; then `ready`, then idles or exits.
 */
const WORKER = (exitAfterMs?: number) => `
const { spawn } = require('child_process');
const fs = require('fs');
const dir = process.argv[process.argv.length - 1];
const idle = ['-e', ${JSON.stringify(IDLE)}];
const opts = (detached) => ({ cwd: dir, detached, stdio: 'ignore' });
const group = spawn(process.execPath, idle, opts(false));
const setsid = spawn(process.execPath, idle, opts(true));
spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(JSON.stringify(IDLE)).slice(1, -1)}],{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.argv[1]+'/daemon.pid',String(c.pid));process.exit(0)", dir], opts(true));
fs.writeFileSync(dir + '/group.pid', String(group.pid));
fs.writeFileSync(dir + '/setsid.pid', String(setsid.pid));
const wait = () => fs.existsSync(dir + '/daemon.pid') ? console.log('ready') : setTimeout(wait, 20);
wait();
${exitAfterMs === undefined ? `${IDLE};` : `setTimeout(() => process.exit(0), ${exitAfterMs});`}
`;

let tmp: ReturnType<typeof tempDir>;
let wt: string;
let logs: string;
const spawned: number[] = [];

beforeEach(() => {
  tmp = tempDir('agent-team-escape-');
  wt = join(tmp.dir, 'worktrees', 'demo', 't_escape');
  logs = join(tmp.dir, 'data', 'runs', 'r_escape');
  mkdirSync(wt, { recursive: true });
  mkdirSync(logs, { recursive: true });
});
afterEach(() => {
  // no leftover processes, whatever a test did
  for (const name of ['group', 'setsid', 'daemon', 'stranger', 'early']) {
    const pid = pidOf(name);
    if (pid !== undefined) spawned.push(pid);
  }
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  tmp.cleanup();
});

function pidOf(name: string): number | undefined {
  const file = join(wt, `${name}.pid`);
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : undefined;
}
const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const survivors = () =>
  Object.fromEntries(['group', 'setsid', 'daemon'].map((n) => [n, alive(pidOf(n))]));
const NONE = { group: false, setsid: false, daemon: false };

function workerScript(exitAfterMs?: number): string {
  const file = join(tmp.dir, `worker-${exitAfterMs ?? 'idle'}.cjs`);
  writeFileSync(file, WORKER(exitAfterMs));
  return file;
}

function worker(opts: {
  timeoutMs?: number;
  signal?: AbortSignal;
  exitAfterMs?: number;
  ownership?: boolean;
}) {
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => (ready = resolve));
  const done = runChild({
    command: process.execPath,
    args: [workerScript(opts.exitAfterMs), wt],
    cwd: wt,
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: opts.timeoutMs ?? 20_000,
    killGraceMs: 300,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.ownership === false ? {} : { ownership: { markers: [wt, logs] } }),
    onStdoutLine: (line) => {
      if (line === 'ready') ready();
    },
  });
  return { done, isReady };
}

/** A detached idle process with `cwd`, its own parent gone (a daemon), started now. */
async function daemonIn(cwd: string, name: string): Promise<number> {
  const file = join(wt, `${name}.pid`);
  const mid = spawn(
    process.execPath,
    [
      '-e',
      `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{cwd:${JSON.stringify(cwd)},detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(file)},String(c.pid));process.exit(0)`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  await new Promise((r) => mid.once('exit', r));
  expect(await eventually(() => existsSync(file))).toBe(true);
  return Number(readFileSync(file, 'utf8'));
}

describe('escaped worker descendants (real processes)', { timeout: 30_000 }, () => {
  it('timeout: the group, the setsid child and the daemon all go', async () => {
    // long enough for four node start-ups under a loaded test run
    const run = worker({ timeoutMs: 6000 });
    await run.isReady;
    expect(survivors()).toEqual({ group: true, setsid: true, daemon: true });
    expect((await run.done).reason).toBe('timeout');
    expect(survivors()).toEqual(NONE);
  });

  it('cancel (and shutdown, which aborts the run): all go', async () => {
    const ac = new AbortController();
    const run = worker({ signal: ac.signal });
    await run.isReady;
    ac.abort();
    expect((await run.done).reason).toBe('aborted');
    expect(survivors()).toEqual(NONE);
  });

  it('a normal exit: what the worker left behind goes before the run resolves', async () => {
    const run = worker({ exitAfterMs: 800 });
    await run.isReady;
    expect((await run.done).reason).toBe('exit');
    expect(survivors()).toEqual(NONE);
  });

  it('without ownership paths only the snapshot applies: a daemon whose parents are gone survives', async () => {
    // the server's own helpers (grokmsg, leader turns) pass no paths: nothing is swept for them
    const run = worker({ timeoutMs: 6000, ownership: false });
    await run.isReady;
    await run.done;
    expect(survivors()).toEqual({ group: false, setsid: false, daemon: true });
  });

  it('leaves alone what it cannot attribute: started before the run, a live parent, another directory', async () => {
    const early = await daemonIn(wt, 'early'); // same worktree, but older than the run
    await sleep(1100); // start times have second resolution
    const other = join(tmp.dir, 'worktrees', 'demo', 't_other');
    mkdirSync(other, { recursive: true });
    const run = worker({ exitAfterMs: 1200 });
    await run.isReady;
    const stranger = await daemonIn(other, 'stranger'); // during the run, another task's tree
    const child = spawn(process.execPath, ['-e', IDLE], { cwd: wt, stdio: 'ignore' }); // a live parent
    spawned.push(child.pid!);
    await run.done;
    expect(survivors()).toEqual(NONE);
    expect(alive(early)).toBe(true);
    expect(alive(stranger)).toBe(true);
    expect(alive(child.pid)).toBe(true);
  });
});

describe('crash recovery (ProcessControl, real processes)', { timeout: 30_000 }, () => {
  /** A worker of a crashed service: its own group, still running, nobody waiting for it. */
  async function orphanedWorker(): Promise<{ pid: number; startedAt: string; since: string }> {
    const since = new Date().toISOString();
    const child = spawn(process.execPath, [workerScript(), wt], {
      cwd: wt,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    spawned.push(child.pid!);
    expect(
      await eventually(() => pidOf('daemon') !== undefined && pidOf('setsid') !== undefined),
    ).toBe(true);
    const startedAt = (await readProcessStart(child.pid!))!;
    return { pid: child.pid!, startedAt, since };
  }

  it('terminates the recorded group and its setsid child; the sweep takes the daemon', async () => {
    const w = await orphanedWorker();
    const control = createProcessControl({ graceMs: 300 });
    expect(await control.terminateGroup({ pid: w.pid, startedAt: w.startedAt })).toBe('terminated');
    expect(survivors()).toEqual({ group: false, setsid: false, daemon: true });
    const sweep = await control.reapOrphans!({ paths: [wt, logs], since: w.since });
    expect(sweep.supported).toBe(true);
    expect(sweep.terminated).toContain(pidOf('daemon'));
    expect(sweep.survivors).toEqual([]);
    expect(survivors()).toEqual(NONE);
  });

  it('a leaderless group: unconfirmed by pid alone, gone once its members are proven and swept', async () => {
    const w = await orphanedWorker();
    process.kill(w.pid, 'SIGKILL'); // the worker died, its group member lives on (parent: init)
    expect(await eventually(() => !alive(w.pid))).toBe(true);
    await sleep(100);
    const control = createProcessControl({ graceMs: 300 });
    expect(await control.terminateGroup({ pid: w.pid, startedAt: w.startedAt })).toBe(
      'unconfirmed',
    );
    const sweep = await control.reapOrphans!({ paths: [wt, logs], since: w.since });
    expect(sweep.terminated).toEqual(expect.arrayContaining([pidOf('group'), pidOf('daemon')]));
    expect(await control.terminateGroup({ pid: w.pid, startedAt: w.startedAt })).toBe(
      'not_running',
    );
    expect(survivors()).toEqual(NONE);
  });

  it('never matches on a weak path: the temp root, a short path or another tree', async () => {
    const w = await orphanedWorker();
    const control = createProcessControl({ graceMs: 300 });
    for (const paths of [
      [tmp.dir.split('/').slice(0, 3).join('/')],
      ['/'],
      [join(tmp.dir, 'nope')],
    ]) {
      const sweep = await control.reapOrphans!({ paths, since: w.since });
      expect(sweep.terminated).toEqual([]);
    }
    expect(alive(pidOf('daemon'))).toBe(true);
    await control.terminateGroup({ pid: w.pid, startedAt: w.startedAt });
    await control.reapOrphans!({ paths: [wt], since: w.since });
    expect(survivors()).toEqual(NONE);
  });
});
