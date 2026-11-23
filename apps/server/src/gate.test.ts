import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGateGit } from '@agent-team/git';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  local,
  TEST_LEADER_TOKEN,
  type Loose,
  type TestService,
} from './testing/harness.js';

// spec §19 end to end over HTTP: POST /api/gate + GET /api/gate/{id} with the real git side on
// temporary repositories (OS temp dir) and the fake check executor.

let h: TestService | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

interface Setup {
  h: TestService;
  repo: string;
  base: string;
  worktree: string;
  projectId: string;
  sh: (cwd: string, ...args: string[]) => string;
}

function setup(
  opts: { checks?: Array<{ name: string; cmd: string }>; maxConcurrent?: number } = {},
): Setup {
  let root = '';
  const gitEnv = () => ({
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
  h = createTestService({
    configure: (c) => {
      c.gate.max_concurrent = opts.maxConcurrent ?? 2;
    },
    gateGit: createGateGit({
      extraEnv: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }),
  });
  root = h.root;
  writeFileSync(join(root, 'gitconfig'), '');
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@x.invalid', ...args], {
      cwd,
      env: gitEnv(),
    })
      .toString()
      .trim();
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# r\n');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  const base = sh(repo, 'rev-parse', 'HEAD');
  const worktree = join(root, 't3-worktrees', 'feat');
  sh(repo, 'worktree', 'add', '-q', '-b', 't3/feat', worktree, 'main');
  const project = h.service.engine.createProject({
    name: 'demo',
    repo_path: repo,
    checks: opts.checks ?? [{ name: 'test', cmd: 'pnpm test' }],
  });
  return { h, repo, base, worktree, projectId: project.id, sh };
}

async function post(s: Setup, body: Record<string, unknown> = {}, token?: string) {
  const res = await s.h.localApp().request(
    '/api/gate',
    local(
      {
        project_id: s.projectId,
        worktree_path: s.worktree,
        base_sha: s.base,
        owned_paths: ['src/'],
        ...body,
      },
      {},
      token,
    ),
  );
  return { status: res.status, body: (await res.json()) as Loose };
}

async function get(s: Setup, id: string, token?: string) {
  const res = await s.h.localApp().request(`/api/gate/${id}`, local(undefined, {}, token));
  return { status: res.status, body: (await res.json()) as Loose };
}

/** POST, wait for the job, GET its result. */
async function gate(s: Setup, body: Record<string, unknown> = {}) {
  const started = await post(s, body);
  expect(started.status).toBe(202);
  expect(started.body.state).toBe('running');
  await s.h.service.gates!.idle();
  const job = await get(s, started.body.gate_id);
  expect(job.status).toBe(200);
  expect(job.body.state).toBe('done');
  return job.body;
}

describe('§19 POST /api/gate', () => {
  it('pass: checks run in the worktree, only the verified files are committed, one event', async () => {
    const s = setup();
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(s.worktree, 'src', 'new.ts'), 'export const n = 1;\n'); // untracked
    const job = await gate(s);
    expect(job).toMatchObject({
      verdict: 'pass',
      reasons: [],
      files_changed: ['src/a.ts', 'src/new.ts'],
      out_of_scope: [],
      checks: [{ name: 'test', cmd: 'pnpm test', result: 'pass', tail: 'ok' }],
      committed: true,
    });
    expect(job.ended_at).toBeDefined();
    expect(s.h.checks.calls).toHaveLength(1);
    expect(s.h.checks.calls[0]!.logPath).toBe(join(s.h.dataDir, 'gate', job.gate_id, '1-test.log'));
    expect(s.sh(s.worktree, 'rev-parse', 'HEAD')).toBe(job.head_sha);
    expect(s.sh(s.worktree, 'log', '-1', '--format=%an|%s')).toBe('agent-team|team(gate): t3/feat');
    expect(s.sh(s.worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe(
      'src/a.ts\nsrc/new.ts',
    );
    expect(s.sh(s.worktree, 'status', '--porcelain')).toBe('');
    expect(s.sh(s.repo, 'rev-parse', 'main')).toBe(s.base);
    const events = s.h.store.events.listAfter(0).filter((e) => e.type === 'gate.completed');
    expect(events.map((e) => e.data)).toEqual([
      { gate_id: job.gate_id, project_id: s.projectId, verdict: 'pass' },
    ]);

    // rerun after the commit: the same change verified again, nothing new to commit
    const again = await gate(s);
    expect(again).toMatchObject({
      verdict: 'pass',
      files_changed: ['src/a.ts', 'src/new.ts'],
      committed: false,
      head_sha: job.head_sha,
    });
  });

  it('out_of_scope: a changed file outside owned_paths is rejected before any check', async () => {
    const s = setup();
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(s.worktree, 'README.md'), '# changed\n');
    writeFileSync(join(s.worktree, 'notes.md'), 'untracked\n');
    const job = await gate(s);
    expect(job.verdict).toBe('rejected');
    expect(job.out_of_scope).toEqual(['README.md', 'notes.md']);
    expect(job.committed).toBe(false);
    expect(s.h.checks.calls).toHaveLength(0);
    expect(s.sh(s.worktree, 'rev-parse', 'HEAD')).toBe(s.base);
  });

  it('checks_failed: no commit; the tail comes back', async () => {
    const s = setup({
      checks: [
        { name: 'test', cmd: 'pnpm test' },
        { name: 'lint', cmd: 'pnpm lint' },
      ],
    });
    s.h.checks.setResult('test', { passed: false, tail: 'FAIL src/a.test.ts' });
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const job = await gate(s);
    expect(job.verdict).toBe('checks_failed');
    expect(job.checks.map((c: Loose) => [c.name, c.result, c.tail])).toEqual([
      ['test', 'fail', 'FAIL src/a.test.ts'],
      ['lint', 'pass', 'ok'],
    ]);
    expect(job.committed).toBe(false);
    expect(s.sh(s.worktree, 'rev-parse', 'HEAD')).toBe(s.base);
  });

  it('a file created by a check gets the job rejected and nothing committed', async () => {
    const s = setup();
    s.h.checks.setResult('test', (input) => {
      writeFileSync(join(input.cwd, 'src', 'generated.ts'), 'export {};\n');
      return { passed: true };
    });
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const job = await gate(s);
    expect(job.verdict).toBe('rejected');
    expect(job.reasons).toEqual(['files changed during the checks: +src/generated.ts']);
    expect(job.committed).toBe(false);
    expect(s.sh(s.worktree, 'rev-parse', 'HEAD')).toBe(s.base);
  });

  it('preconditions: primary checkout, HEAD on the base branch, base not an ancestor, no changes', async () => {
    const s = setup();
    const primary = await gate(s, { worktree_path: s.repo });
    expect(primary.verdict).toBe('rejected');
    expect(primary.reasons[0]).toContain('primary checkout');

    const noChanges = await gate(s);
    expect(noChanges.verdict).toBe('rejected');
    expect(noChanges.reasons[0]).toContain('no changes');

    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(s.repo, 'README.md'), '# later\n');
    s.sh(s.repo, 'commit', '-q', '-am', 'later');
    const later = s.sh(s.repo, 'rev-parse', 'HEAD');
    const notAncestor = await gate(s, { base_sha: later });
    expect(notAncestor.reasons[0]).toContain('not an ancestor');

    const onBase = join(s.h.root, 't3-worktrees', 'release');
    s.sh(s.repo, 'worktree', 'add', '-q', '-b', 'release', onBase, s.base);
    s.h.service.engine.updateProject(s.projectId, { checks: [] });
    s.h.store.projects.update({ ...s.h.store.projects.get(s.projectId)!, base_branch: 'release' });
    const base = await gate(s, { worktree_path: onBase });
    expect(base.reasons[0]).toContain('base branch release');

    const missing = await gate(s, { project_id: 'p_999999' });
    expect(missing.reasons).toEqual(['project p_999999 not found']);
    expect(s.h.checks.calls).toHaveLength(0);
  });

  it('no checks: noted in reasons; --no-commit verifies only', async () => {
    const s = setup({ checks: [] });
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const job = await gate(s, { commit: false });
    expect(job).toMatchObject({
      verdict: 'pass',
      reasons: ['no machine checks'],
      checks: [],
      committed: false,
      head_sha: s.base,
    });
    expect(s.sh(s.worktree, 'status', '--porcelain')).toBe('M src/a.ts');
  });

  it('is human-only: the leader token is refused for both routes', async () => {
    const s = setup();
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const refused = await post(s, {}, TEST_LEADER_TOKEN);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('forbidden');
    expect((await get(s, 'g_000001', TEST_LEADER_TOKEN)).status).toBe(403);
    expect(s.h.checks.calls).toHaveLength(0);
    // the job table refuses the leader too (defence in depth)
    expect(() =>
      s.h.service.gates!.start(
        {
          project_id: s.projectId,
          worktree_path: s.worktree,
          base_sha: s.base,
          owned_paths: ['src/'],
        },
        { kind: 'leader' },
      ),
    ).toThrow('humans only');
  });

  it('429 at gate.max_concurrent; 404 for an unknown job; 400 for a bad owned path', async () => {
    const s = setup({ maxConcurrent: 1 });
    s.h.checks.setResult('test', 'hang');
    writeFileSync(join(s.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const first = await post(s);
    expect(first.status).toBe(202);
    for (let i = 0; i < 100 && s.h.checks.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = await post(s);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('too_many_requests');
    expect((await get(s, first.body.gate_id)).body.state).toBe('running');
    expect((await get(s, 'g_999999')).status).toBe(404);
    expect((await post(s, { owned_paths: ['../x'] })).status).toBe(400);
    // stopping the service kills the running check; the job ends rejected, nothing committed
    await s.h.service.gates!.stop();
    const ended = await get(s, first.body.gate_id);
    expect(ended.body).toMatchObject({ state: 'done', verdict: 'rejected', committed: false });
  });
});
