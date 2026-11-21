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
import { fileURLToPath } from 'node:url';
import { createTeamClient, type TeamClient } from '@agent-team/client';

// Boots the real server (apps/server/src/main.ts through tsx) for the board smoke test:
// in-process fake runners, a temp AGENT_TEAM_HOME / config / .env / HOME, a fresh git repo, both
// listeners on ephemeral loopback ports. The web app may not import the server, so it is a child
// process, the same way `team serve` starts it.

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '../..');
const serverMain = join(repoRoot, 'apps/server/src/main.ts');
const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

export const TEST_PASSWORD = 'e2e board password 42';

export interface TestServer {
  lanUrl: string;
  localUrl: string;
  repoPath: string;
  /** Typed client on the local (bearer) listener, e.g. to seed a project (local-only route). */
  local: TeamClient;
  /** Everything the server wrote (for failure messages). */
  output(): string;
  stop(): Promise<void>;
}

function git(cwd: string, home: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], {
    cwd,
    stdio: 'ignore',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

export async function startServer(): Promise<TestServer> {
  if (!existsSync(join(webDir, 'dist/index.html'))) {
    throw new Error('apps/web/dist is missing: run `pnpm --filter @agent-team/web build` first');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agent-team-web-e2e-'));
  const home = join(tmp, 'home');
  const data = join(tmp, 'data');
  const config = join(tmp, 'config');
  const repoPath = join(tmp, 'repo');
  for (const dir of [home, data, config, repoPath]) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(config, 'service.json'),
    JSON.stringify({
      local: { host: '127.0.0.1', port: 0 },
      lan: { enabled: true, host: '127.0.0.1', port: 0 },
      paths: { worktree_root: join(tmp, 'worktrees') },
      engine: { tick_ms: 500 },
    }),
  );
  copyFileSync(join(repoRoot, 'config/models.json'), join(config, 'models.json'));
  const envFile = join(tmp, 'test.env');
  writeFileSync(envFile, `TEAM_LAN_PASSWORD="${TEST_PASSWORD}"\n`);

  writeFileSync(join(repoPath, 'README.md'), '# e2e\n');
  git(repoPath, home, 'init', '-q', '-b', 'main');
  git(repoPath, home, 'add', '.');
  git(repoPath, home, 'commit', '-q', '-m', 'init');

  let output = '';
  const child = spawn(process.execPath, [tsxCli, '--conditions=@agent-team/source', serverMain], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      AGENT_TEAM_HOME: data,
      AGENT_TEAM_CONFIG_DIR: config,
      AGENT_TEAM_ENV_FILE: envFile,
      AGENT_TEAM_FAKE_RUNNERS: '1',
    },
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const stop = async () => {
    child.kill('SIGTERM');
    if (!(await waitForExit(child, 8000))) {
      child.kill('SIGKILL');
      await waitForExit(child, 2000);
    }
    rmSync(tmp, { recursive: true, force: true });
  };

  try {
    const lanUrl = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`server did not start:\n${output}`)), 60_000);
      const check = () => {
        const match = /區網看板：(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          ok(match[1]!);
        }
      };
      child.stdout?.on('data', check);
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`server exited (${code}):\n${output}`));
      });
    });
    const listener = JSON.parse(readFileSync(join(data, 'run/listener.json'), 'utf8')) as {
      addr: string;
      token: string;
    };
    const local = createTeamClient({ baseUrl: listener.addr, token: listener.token });
    return { lanUrl, localUrl: listener.addr, repoPath, local, output: () => output, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
