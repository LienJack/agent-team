import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';

function commits(h: ReturnType<typeof createTestEngine>) {
  return h.git.calls.filter((c) => c.method === 'commitFiles');
}

describe('H3 the changed-file list is recomputed right before the commit', () => {
  it('a check that rewrites a file outside owned_paths: run rejected, nothing committed', async () => {
    const h = createTestEngine();
    h.checks.setResult('test', ({ cwd }) => {
      h.git.touch(cwd, ['docs/generated.md']);
      return { passed: true };
    });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']), { hold: true });
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(run.outcome).toBe('rejected');
    expect(run.reject_reason).toMatch(/^changed_during_checks: .*docs\/generated\.md/);
    expect(commits(h)).toHaveLength(0);
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    expect(ws.head_sha).toBeNull();
    expect(h.get(task.id)).toMatchObject({ status: 'running', fix_rounds: 1 }); // the fix run
    expect(h.get(task.id).fix_notes).toContain('docs/generated.md');
  });

  it('a check that adds a new file, even inside owned_paths: rejected (the set grew)', async () => {
    const h = createTestEngine();
    h.checks.setResult('test', ({ cwd }) => {
      h.git.touch(cwd, ['src/feature/snapshot.snap']);
      return { passed: true };
    });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']), { hold: true });
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(run.reject_reason).toMatch(/changed_during_checks/);
    expect(commits(h)).toHaveLength(0);
  });

  it('commits exactly the verified list', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts', 'src/feature/b.ts']));
    const task = h.task();
    await h.engine.drain();
    expect(['review', 'done']).toContain(h.get(task.id).status);
    expect(commits(h).map((c) => (c.input as { files: string[] }).files)).toEqual([
      ['src/feature/a.ts', 'src/feature/b.ts'],
    ]);
  });
});

describe('M7 ownership resolves symlinks and follows the filesystem case rules', () => {
  it('a symlink inside owned_paths that points outside them is out of bounds', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({
      onRun: (spec) => {
        h.git.touch(spec.cwd, ['src/feature/link']);
        h.git.link(spec.cwd, 'src/feature/link', 'config/secret.json');
      },
    });
    const task = h.task();
    await h.engine.drain();
    const run = h.store.runs.list({ task_id: task.id })[0]!;
    expect(run.reject_reason).toMatch(/^out_of_bounds: src\/feature\/link -> config\/secret\.json/);
    expect(commits(h)).toHaveLength(0);
  });

  it('a symlink that leaves the worktree is out of bounds', async () => {
    const h = createTestEngine();
    h.runners.dsh.script({
      onRun: (spec) => {
        h.git.touch(spec.cwd, ['src/feature/escape']);
        h.git.link(spec.cwd, 'src/feature/escape', null);
      },
    });
    const task = h.task();
    await h.engine.drain();
    expect(h.store.runs.list({ task_id: task.id })[0]!.reject_reason).toMatch(
      /out_of_bounds: src\/feature\/escape -> \(outside the worktree\)/,
    );
  });

  it('compares case-insensitively on a case-insensitive filesystem only', async () => {
    const insensitive = createTestEngine();
    insensitive.git.caseInsensitive.add('/repos/demo');
    insensitive.runners.dsh.script(editing(insensitive.git, ['src/feature/a.ts']));
    const a = insensitive.task({ owned_paths: ['src/Feature/'] });
    await insensitive.engine.drain();
    expect(insensitive.store.runs.list({ task_id: a.id })[0]!.outcome).toBe('ok');

    const sensitive = createTestEngine();
    sensitive.runners.dsh.script(editing(sensitive.git, ['src/feature/a.ts']));
    const b = sensitive.task({ owned_paths: ['src/Feature/'] });
    await sensitive.engine.drain();
    expect(sensitive.store.runs.list({ task_id: b.id })[0]!.reject_reason).toMatch(
      /^out_of_bounds/,
    );
  });
});
