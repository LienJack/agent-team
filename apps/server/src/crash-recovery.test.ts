import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSqliteStore } from '@agent-team/db';
import { processAlive, readRecords, type FakeScenario } from '@agent-team/runners/testing';
import { afterEach, describe, expect, it } from 'vitest';

// Scenario (a) of the review (H2), for real: the server runs as its own OS process with the
// claude worker replaced by the scripted fake CLI (a long-running, silent worker with a child in
// its process group). The server is killed with SIGKILL mid-run and started again on the same
// data directory: recovery must terminate the old worker group (same pid and start time) before
// the task is dispatched again, so no second worker ever shares the worktree with the first.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
// tsx's loader in this process (not the tsx CLI, which runs the script in a child process — a
// SIGKILL of the CLI would leave the real server running)
const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const entry = join(here, 'testing/crash-entry.ts');
const fakeCli = join(repoRoot, 'packages/runners/src/testing/fake-cli.ts');
const fixtures = join(repoRoot, 'packages/runners/src/claude/__fixtures__');

let tmp: string | undefined;
const servers: ChildProcess[] = [];
const groups = new Set<number>();

afterEach(() => {
  for (const s of servers.splice(0)) if (s.exitCode === null) s.kill('SIGKILL');
  for (const g of groups) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // gone
    }
  }
  groups.clear();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function startServer(dir: string, scenario: string): { child: ChildProcess; out: () => string } {
  let output = '';
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, '--conditions=@agent-team/source', entry, scenario, fakeCli],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: join(dir, 'home'),
        TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
        AGENT_TEAM_HOME: join(dir, 'data'),
        AGENT_TEAM_CONFIG_DIR: join(dir, 'config'),
        AGENT_TEAM_ENV_FILE: join(dir, 'test.env'),
      },
    },
  );
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  servers.push(child);
  return { child, out: () => output };
}

async function until<T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  ms = 30_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Api = (path: string, body?: unknown) => Promise<Record<string, any>>; // oxlint-disable-line no-explicit-any

/** A minimal bearer client for the local listener (apps/server does not depend on the client). */
async function connect(data: string, out: () => string, stale?: string): Promise<Api> {
  const file = join(data, 'run/listener.json');
  // a killed server leaves its listener.json behind: wait for the new one
  const text = await until(`listener.json (${out()})`, () => {
    const t = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    return t !== undefined && t !== stale ? t : undefined;
  });
  const { addr, token } = JSON.parse(text) as { addr: string; token: string };
  return async (path, body) => {
    const res = await fetch(`${addr}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Record<string, any>; // oxlint-disable-line no-explicit-any
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}

describe('H2 crash recovery with a real server process (kill -9 mid-run)', () => {
  it('terminates the orphaned worker group before the task gets another worker', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-team-crash-'));
    const dir = tmp;
    for (const d of ['home', 'data', 'config', 'repo', 'cli']) mkdirSync(join(dir, d));
    writeFileSync(
      join(dir, 'config/service.json'),
      JSON.stringify({
        local: { host: '127.0.0.1', port: 0 },
        lan: { enabled: false },
        paths: { worktree_root: join(dir, 'worktrees') },
        engine: { tick_ms: 200 },
        leader: { enabled: false },
      }),
    );
    copyFileSync(join(repoRoot, 'config/models.json'), join(dir, 'config/models.json'));
    writeFileSync(join(dir, 'test.env'), 'TEAM_LAN_PASSWORD="not-used-here"\n');
    const repo = join(dir, 'repo');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.invalid', ...args], {
        cwd: repo,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(dir, 'home') },
        stdio: 'ignore',
      });
    writeFileSync(join(repo, 'README.md'), '# crash\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    // the fake claude: answers the probe, starts (system init), spawns a child, then hangs
    // silently (no stdout after the crash, so it does not die of a broken pipe)
    const help = readFileSync(join(fixtures, 'help.txt'), 'utf8');
    const init = readFileSync(join(fixtures, 'success.jsonl'), 'utf8').split('\n')[0]!;
    const recordPath = join(dir, 'cli/record.jsonl');
    const scenario: FakeScenario = {
      recordPath,
      responses: [
        { argv: ['--version'], stdout: '2.1.326 (Claude Code)\n' },
        { argv: ['--help'], stdout: help },
        { argv: ['auth', 'status', '--json'], stdout: '{"loggedIn":true}\n' },
      ],
      steps: [{ out: init }, { spawnChild: true }, { hang: true }],
    };
    const scenarioPath = join(dir, 'cli/scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    // --- first server: dispatch and get the worker running
    const first = startServer(dir, scenarioPath);
    const api = await connect(join(dir, 'data'), first.out);
    const firstListener = readFileSync(join(dir, 'data/run/listener.json'), 'utf8');
    const project = await api('/projects', { name: 'crash', repo_path: repo });
    const task = await api('/tasks', {
      project_id: project.project.id,
      title: 'long worker',
      tier: 'A', // impl_A → claude (the fake)
      ticket_md: '# t',
      owned_paths: ['src/'],
      queue: true,
    });
    const taskId = task.task.id;
    const workers = () => readRecords(recordPath).filter((r) => r.stdin !== '');
    const worker = await until('the first worker and its child', () => {
      const w = workers().at(-1);
      return w && w.children.length > 0 ? w : undefined;
    });
    groups.add(worker.pid);
    const running = await until('run running', async () => {
      const d = await api(`/tasks/${taskId}`);
      const run = (d.runs as Array<Record<string, unknown>>).at(-1);
      return run?.['state'] === 'running' && run['pid'] !== null ? run : undefined;
    });
    expect(running['pid']).toBe(worker.pid);
    expect(running['pid_started_at']).toBeTruthy();

    // --- crash: SIGKILL the server; the worker group (own session) survives it
    first.child.kill('SIGKILL');
    await until('server dead', () =>
      first.child.exitCode !== null || first.child.signalCode ? true : undefined,
    );
    expect(processAlive(worker.pid)).toBe(true);
    expect(processAlive(worker.children[0]!)).toBe(true);
    const before = workers().length;

    // --- restart on the same data directory
    const second = startServer(dir, scenarioPath);
    const api2 = await connect(join(dir, 'data'), second.out, firstListener);
    await until('old worker group terminated', () =>
      !processAlive(worker.pid) && !processAlive(worker.children[0]!) ? true : undefined,
    );
    const detail = await until('task dispatched again', async () => {
      const d = await api2(`/tasks/${taskId}`);
      return (d.runs as unknown[]).length >= 2 ? d : undefined;
    });
    const [oldRun, newRun] = detail.runs as Array<{ id: string; state: string }>;
    expect(oldRun).toMatchObject({ id: running['id'], state: 'abandoned' });
    expect(newRun!.id).not.toBe(oldRun!.id);
    const second2 = await until('second worker', () =>
      workers().length > before ? workers().at(-1) : undefined,
    );
    groups.add(second2.pid);
    expect(second2.pid).not.toBe(worker.pid);

    second.child.kill('SIGTERM');
    await until(
      'server stopped',
      () => (second.child.exitCode !== null ? true : undefined),
      15_000,
    );
    expect(processAlive(second2.pid)).toBe(false); // graceful stop terminates its worker

    // recovery (which terminated the old group) committed before the new run was created
    const store = createSqliteStore({ path: join(dir, 'data', 'team.db') });
    try {
      const events = store.events.listAfter(0);
      const recovered = events.find(
        (e) => e.type === 'recovery.completed' && e.data.abandoned_runs.includes(oldRun!.id),
      );
      expect(recovered?.data).toMatchObject({ terminated_runs: [oldRun!.id], blocked_tasks: [] });
      const created = events.find((e) => e.type === 'run.created' && e.run_id === newRun!.id)!;
      expect(created.seq).toBeGreaterThan(recovered!.seq);
    } finally {
      store.close();
    }
  }, 90_000);
});
