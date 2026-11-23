import type { GateJob } from '@agent-team/client';
import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

// spec §19: `team gate` submits, polls until done, prints a short verdict; exit 0 only on pass.

const BASE = 'a'.repeat(40);
const job = (over: Partial<GateJob>): GateJob => ({
  gate_id: 'g_000001',
  project_id: 'p_000001',
  worktree_path: '/work/wt',
  state: 'done',
  reasons: [],
  files_changed: ['src/a.ts', 'src/b.ts'],
  out_of_scope: [],
  checks: [{ name: 'test', cmd: 'pnpm test', result: 'pass', tail: 'ok' }],
  committed: true,
  head_sha: 'b'.repeat(40),
  started_at: '2026-11-23T00:00:00.000Z',
  ended_at: '2026-11-23T00:00:05.000Z',
  verdict: 'pass',
  ...over,
});

function client(result: GateJob, bodies: unknown[]) {
  let polls = 0;
  return fakeClient({
    listProjects: async () => [
      {
        id: 'p_000001',
        name: 'demo',
        repo_path: '/repos/demo',
        base_branch: 'main',
        checks: [],
        allow_network: false,
        created_at: '2026-11-21T00:00:00.000Z',
      },
    ],
    startGate: async (body) => {
      bodies.push(body);
      return { gate_id: 'g_000001', state: 'running' };
    },
    // running once, then done
    getGate: async () => {
      if (polls++ > 0) return result;
      const { verdict: _verdict, ...running } = job({ state: 'running' });
      return running;
    },
  });
}

describe('team gate', () => {
  it('resolves the project and a relative worktree, polls to done, exits 0 on pass', async () => {
    const bodies: unknown[] = [];
    const io = captureIo(client(job({}), bodies), { gatePollMs: 1 });
    const code = await runCli(
      [
        'gate',
        'demo',
        '--worktree',
        'wt',
        '--base',
        BASE.toUpperCase(),
        '--paths',
        'src/, docs/x.md',
      ],
      io,
    );
    expect(code).toBe(0);
    expect(bodies).toEqual([
      {
        project_id: 'p_000001',
        worktree_path: '/work/wt',
        base_sha: BASE,
        owned_paths: ['src/', 'docs/x.md'],
        commit: true,
      },
    ]);
    expect(io.text()).toBe(
      `g_000001 pass (committed) head ${'b'.repeat(12)} · 2 file(s) changed\n  check test: pass\n`,
    );
  });

  it('rejected and checks_failed exit 1 and show why; --no-commit and --message pass through', async () => {
    const bodies: unknown[] = [];
    const rejected = job({
      verdict: 'rejected',
      committed: false,
      reasons: ['1 changed file(s) outside owned_paths'],
      out_of_scope: ['README.md'],
      checks: [],
    });
    const io = captureIo(client(rejected, bodies), { gatePollMs: 1 });
    const argv = ['gate', 'p_000001', '--worktree', '/abs/wt', '--base', BASE, '--paths', 'src/'];
    expect(await runCli([...argv, '--no-commit', '--message', 'feat: x'], io)).toBe(1);
    expect(bodies[0]).toMatchObject({
      commit: false,
      commit_message: 'feat: x',
      worktree_path: '/abs/wt',
    });
    expect(io.text()).toContain('rejected');
    expect(io.text()).toContain('  out of scope:\n    README.md');

    const failed = job({
      verdict: 'checks_failed',
      committed: false,
      checks: [{ name: 'test', cmd: 'pnpm test', result: 'fail', tail: 'FAIL a\nexpected 1' }],
    });
    const io2 = captureIo(client(failed, []), { gatePollMs: 1 });
    expect(await runCli([...argv, '--json'], io2)).toBe(1);
    expect(JSON.parse(io2.text()).verdict).toBe('checks_failed');
    const io3 = captureIo(client(failed, []), { gatePollMs: 1 });
    expect(await runCli(argv, io3)).toBe(1);
    expect(io3.text()).toContain('  check test: fail\n    | FAIL a\n    | expected 1');
  });

  it('missing options are usage errors', async () => {
    const io = captureIo(fakeClient({}));
    expect(await runCli(['gate', 'demo', '--worktree', '/w', '--base', BASE], io)).toBe(2);
  });
});
