import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, InMemoryStore } from '@agent-team/core';
import {
  FakeCheckExecutor,
  InMemoryRunnerRegistry,
  ManualClock,
  SequentialIdGen,
  testEngineConfig,
} from '@agent-team/core/testing';
import { taskWorktreePath, type Workspace } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillReviewDiff, splitDiffSections } from './review-diff.js';
import { cleanup, commitChanges, newWorktree, setup, type Fixture } from './test-fixture.js';

let fx: Fixture;
beforeEach(() => {
  fx = setup();
});
afterEach(() => cleanup(fx));

describe('git review diff (docs/adr/0008)', () => {
  it('returns the full --stat and whole per-file sections of base..head', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), 'a changed\n');
    writeFileSync(join(wt.worktreePath, 'new file.txt'), 'n\n');
    const c = await commitChanges(fx, wt.worktreePath, 'work');
    // uncommitted edits are not part of the reviewed change
    writeFileSync(join(wt.worktreePath, 'b.txt'), 'dirty\n');

    const d = await fx.port.reviewDiff({
      worktreePath: wt.worktreePath,
      baseSha: wt.baseSha,
      headSha: c.sha,
      maxChars: 60_000,
    });
    expect(d.truncated).toBe(false);
    expect(d.omittedFiles).toEqual([]);
    expect(d.stat).toMatch(/a\.txt/);
    expect(d.stat).toMatch(/new file\.txt/);
    expect(d.stat).toMatch(/2 files changed/);
    expect(d.diff).toContain('+a changed');
    expect(d.diff).toContain('+n');
    expect(d.diff).not.toContain('dirty');
    expect(splitDiffSections(d.diff)).toHaveLength(2);
  });

  it('leaves out sections that do not fit, lists them, and keeps the stat complete', async () => {
    const wt = await newWorktree(fx);
    writeFileSync(join(wt.worktreePath, 'a.txt'), `${'x'.repeat(5000)}\n`);
    writeFileSync(join(wt.worktreePath, 'b.txt'), 'small\n');
    const c = await commitChanges(fx, wt.worktreePath, 'work');
    const d = await fx.port.reviewDiff({
      worktreePath: wt.worktreePath,
      baseSha: wt.baseSha,
      headSha: c.sha,
      maxChars: 1000,
    });
    expect(d.truncated).toBe(true);
    expect(d.omittedFiles).toEqual(['a.txt']);
    expect(d.diff.length).toBeLessThanOrEqual(1000);
    expect(d.diff).toContain('+small');
    expect(d.stat).toMatch(/a\.txt/);
    expect(d.stat).toMatch(/b\.txt/);
  });

  it('labels sections from their headers when the name list does not match', () => {
    const patch = 'diff --git a/x b/x\n+1\ndiff --git a/y z b/y z\n+2\n';
    expect(fillReviewDiff('s', patch, [], 10)).toEqual({
      stat: 's',
      diff: '',
      truncated: true,
      omittedFiles: ['x', 'y z'],
    });
  });
});

describe('workspace removal through the engine (docs/adr/0009)', () => {
  function engineFor(store = new InMemoryStore()) {
    const data = mkdtempSync(join(tmpdir(), 'agent-team-git-data-'));
    const engine = new Engine({
      store,
      runners: new InMemoryRunnerRegistry(),
      git: fx.port,
      checks: new FakeCheckExecutor(),
      clock: new ManualClock(),
      ids: new SequentialIdGen(),
      config: testEngineConfig({ worktreeRoot: fx.root, dataDir: data, notifications: false }),
    });
    return { engine, store, data };
  }

  async function recordedWorkspace(engine: Engine, store: InMemoryStore) {
    const project = engine.createProject({
      name: 'proj',
      repo_path: fx.repo,
      base_branch: 'main',
      checks: [],
    });
    const task = engine.createTask({
      project_id: project.id,
      title: 't',
      tier: 'C',
      ticket_md: 'x',
      owned_paths: ['a.txt'],
    });
    const path = taskWorktreePath(fx.root, 'proj', task.id);
    const res = await fx.port.ensureWorktree({
      repoPath: fx.repo,
      worktreePath: path,
      branch: `team/${task.id}`,
      baseBranch: 'main',
    });
    const ws: Workspace = {
      id: 'w_000001',
      task_id: task.id,
      path,
      branch: `team/${task.id}`,
      base_sha: res.baseSha,
      head_sha: null,
      accepted_base_sha: null,
      state: 'active',
      created_at: '2026-11-21T00:00:00.000Z',
      removed_at: null,
    };
    store.workspaces.insert(ws);
    return { task, ws };
  }

  it('recovery force-removes a dirty orphan but never a recorded dirty workspace (symlinked tmp root)', async () => {
    const { engine, store, data } = engineFor();
    try {
      const { ws } = await recordedWorkspace(engine, store);
      writeFileSync(join(ws.path, 'a.txt'), 'unsaved work\n');
      const orphan = await newWorktree(fx, 't_orphan1');
      // newWorktree uses <root>/proj/<task>: the same layout as recorded workspaces
      writeFileSync(join(orphan.worktreePath, 'junk.txt'), 'j\n');

      const report = await engine.recover();
      await engine.runUntilIdle();
      expect(report.orphanWorktrees).toEqual([orphan.worktreePath]);
      expect(existsSync(orphan.worktreePath)).toBe(false);
      expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('unsaved work\n');
      expect(store.workspaces.get(ws.id)?.state).toBe('active');
      expect(store.effects.list()).toEqual([]);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('cleanup of a recorded dirty workspace keeps it, opens one attention item and stops', async () => {
    const { engine, store, data } = engineFor();
    try {
      const { task, ws } = await recordedWorkspace(engine, store);
      writeFileSync(join(ws.path, 'a.txt'), 'unsaved work\n');
      const t = store.tasks.get(task.id)!;
      store.tasks.update(
        { ...t, status: 'done', updated_at: '2000-01-01T00:00:00.000Z' },
        t.version,
      );

      await engine.runUntilIdle();
      await engine.runUntilIdle(); // a second pass must not enqueue the removal again
      expect(existsSync(join(ws.path, 'a.txt'))).toBe(true);
      expect(store.workspaces.get(ws.id)?.state).toBe('kept');
      expect(store.effects.list()).toEqual([]);
      const items = store.attention.list({ task_id: task.id });
      expect(items).toHaveLength(1);
      expect(items[0]?.question).toContain('未提交');
      const kept = store.events.listAfter(0).filter((e) => e.type === 'workspace.kept');
      expect(kept).toHaveLength(1);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
