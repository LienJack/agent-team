import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError, Engine, InMemoryStore, type Clock } from '@agent-team/core';
import {
  FakeRunner,
  InMemoryRunnerRegistry,
  SequentialIdGen,
  testEngineConfig,
} from '@agent-team/core/testing';
import { createGitPort } from '@agent-team/git';
import { createCheckExecutor } from '@agent-team/runners';
import { afterEach, describe, expect, it } from 'vitest';

// Scenario (c) of the review, with the real git port and the real check executor: a project
// check that writes a tracked file outside owned_paths gets the run rejected and nothing is
// committed (H3); a queue request on a verifying task is refused (H4); a graceful shutdown stops
// a running check instead of waiting for it (H2).

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const clock: Clock = { now: () => new Date() };

function setup(checkCmd: string) {
  dir = mkdtempSync(join(tmpdir(), 'agent-team-verify-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const gitConfig = join(dir, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: dir,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.invalid', ...args], {
      cwd,
      env,
    })
      .toString()
      .trim();
  writeFileSync(join(repo, 'README.md'), '# r\n');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  const worktreeRoot = join(dir, 'worktrees');
  const git = createGitPort({ worktreeRoot, extraEnv: { GIT_CONFIG_GLOBAL: gitConfig } });
  const registry = new InMemoryRunnerRegistry();
  const dsh = new FakeRunner('dsh');
  for (const r of [dsh, new FakeRunner('codex'), new FakeRunner('claude')]) {
    r.defaultStep = { hold: true };
    registry.register(r);
  }
  dsh.script({
    onRun: (spec) => {
      mkdirSync(join(spec.cwd, 'src', 'feature'), { recursive: true });
      writeFileSync(join(spec.cwd, 'src', 'feature', 'a.ts'), 'export const a = 1;\n');
    },
  });
  const engine = new Engine({
    store: new InMemoryStore(),
    runners: registry,
    git,
    checks: createCheckExecutor({
      killGraceMs: 200,
      // Seatbelt on macOS; elsewhere (CI on Linux) explicitly unsandboxed (docs/adr/0019)
      allowUnsandboxed: true,
      sandbox: { denyPaths: [join(dir, 'data')] },
    }),
    clock,
    ids: new SequentialIdGen(),
    config: testEngineConfig({ dataDir: join(dir, 'data'), worktreeRoot }),
  });
  const project = engine.createProject({
    name: 'demo',
    repo_path: repo,
    checks: [{ name: 'check', cmd: checkCmd }],
  });
  const task = engine.createTask({
    project_id: project.id,
    title: 't',
    tier: 'C',
    ticket_md: '# t',
    owned_paths: ['src/feature/'],
    queue: true,
  });
  return { engine, task, sh };
}

describe('scenario (c) with real git and real checks', () => {
  it('a check that writes outside owned_paths: rejected, nothing committed', async () => {
    const { engine, task, sh } = setup('mkdir -p docs && echo leaked > docs/leak.md');
    await engine.drain();
    const store = engine.ctx.store;
    const run = store.runs.list({ task_id: task.id })[0]!;
    expect(run.outcome).toBe('rejected');
    expect(run.reject_reason).toBe('changed_during_checks: docs/leak.md');
    const ws = store.workspaces.findCurrentByTask(task.id)!;
    expect(ws.head_sha).toBeNull();
    expect(sh(ws.path, 'rev-parse', 'HEAD')).toBe(ws.base_sha); // no commit at all
    expect(sh(ws.path, 'status', '--porcelain')).toContain('docs/');
    await engine.shutdown();
  });

  it('queue on a verifying task is refused, and shutdown aborts the running check', async () => {
    const { engine, task } = setup('sleep 30');
    const store = engine.ctx.store;
    for (let i = 0; i < 200 && store.tasks.get(task.id)!.status !== 'verifying'; i++) {
      void engine.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(store.tasks.get(task.id)!.status).toBe('verifying');
    await new Promise((r) => setTimeout(r, 300)); // the check (sleep 30) is running now
    expect(() => engine.queueTask(task.id)).toThrow(ConflictError);
    const started = Date.now();
    await engine.shutdown();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(store.tasks.get(task.id)!.status).toBe('verifying');
    expect(store.effects.list().some((e) => e.kind === 'run.verify')).toBe(true);
  });
});
