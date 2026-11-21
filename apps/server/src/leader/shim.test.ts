import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamShim } from './process.js';

// The leader's `team` shim (spec §9): the CLI runs locally with this machine's permissions, so
// options that read a local file and commands that never return are refused before node starts;
// everything else runs this repo's CLI as the leader actor against the service's DATA.

let dir: string;
let record: string;
let shim: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-shim-'));
  record = join(dir, 'node-called.txt');
  // stands in for node: records how the shim would have started the CLI
  const node = join(dir, 'node');
  writeFileSync(
    node,
    `#!/bin/sh\necho "$AGENT_TEAM_LISTENER_FILE|$AGENT_TEAM_HOME|$*" > '${record}'\n`,
  );
  chmodSync(node, 0o755);
  shim = join(dir, 'team');
  writeFileSync(shim, teamShim(join(dir, "da'ta"), node, '/repo/apps/cli/dist/bin.js'));
  chmodSync(shim, 0o700);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(shim, args, { env: { PATH: '/usr/bin:/bin' } }, (err, _out, stderr) =>
      done({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stderr }),
    );
  });
}

describe('§9 leader team shim', () => {
  it('runs the CLI as the leader actor with the DATA directory', async () => {
    expect((await run('task', 'list', '--status', 'queued')).code).toBe(0);
    expect(readFileSync(record, 'utf8').trim()).toBe(
      `${join(dir, "da'ta", 'leader', 'listener.json')}|${join(dir, "da'ta")}|/repo/apps/cli/dist/bin.js task list --status queued`,
    );
  });

  it('passes the current turn seed (DATA/leader/turn-key) and drops proxy settings', async () => {
    const node = join(dir, 'node');
    writeFileSync(
      node,
      `#!/bin/sh\necho "$AGENT_TEAM_IDEMPOTENCY_SEED|$HTTPS_PROXY" > '${record}'\n`,
    );
    chmodSync(node, 0o755);
    expect((await run('task', 'list')).code).toBe(0);
    expect(readFileSync(record, 'utf8').trim()).toBe('|'); // no turn running: no seed
    mkdirSync(join(dir, "da'ta", 'leader'), { recursive: true });
    writeFileSync(join(dir, "da'ta", 'leader', 'turn-key'), 'leader:msg:m_abc\n');
    await new Promise<void>((done) =>
      execFile(
        shim,
        ['task', 'list'],
        { env: { PATH: '/usr/bin:/bin', HTTPS_PROXY: 'http://u:p@proxy:1' } },
        () => done(),
      ),
    );
    expect(readFileSync(record, 'utf8').trim()).toBe('leader:msg:m_abc|');
  });

  it('refuses --ticket-file (a local file read) without starting node', async () => {
    for (const args of [
      [
        'task',
        'add',
        '--project',
        'p',
        '--title',
        't',
        '--tier',
        'C',
        '--paths',
        'x',
        '--ticket-file',
        '/etc/hosts',
      ],
      ['task', 'add', '--ticket-file=../../run/listener.json'],
    ]) {
      const res = await run(...args);
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/--ticket-file is not available to the leader/);
      expect(res.stderr).toMatch(/<<'EOF'/);
    }
    expect(existsSync(record)).toBe(false);
  });

  it('refuses serve, watch and ask (also after --json) without starting node', async () => {
    for (const args of [['serve'], ['--json', 'watch'], ['watch', '--after', '3'], ['ask', 'hi']]) {
      const res = await run(...args);
      expect({ args, code: res.code }).toEqual({ args, code: 2 });
      expect(res.stderr).toMatch(/is not available to the leader/);
    }
    expect(existsSync(record)).toBe(false);
    // a title that happens to be a refused word is fine
    expect((await run('task', 'add', '--title', 'serve', '-')).code).toBe(0);
  });
});
