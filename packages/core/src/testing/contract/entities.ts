import { describe, expect, it } from 'vitest';
import { UniqueViolationError } from '../../errors.js';
import type { Store } from '../../ports/repositories.js';
import { sampleProject, sampleRun, sampleTask, sampleWorkspace } from '../fixtures.js';

const at = (n: number) => `2026-11-21T00:00:0${n}.000Z`;

/** Parent rows the foreign keys require: project p_000001, task t_000001, workspace w_000001. */
export function seedParents(s: Store, depth: 'project' | 'task' | 'workspace' = 'workspace'): void {
  s.projects.insert(sampleProject());
  if (depth === 'project') return;
  s.tasks.insert(sampleTask());
  if (depth === 'task') return;
  s.workspaces.insert(sampleWorkspace());
}

/** projects, tasks (optimistic lock), workspaces, runs. */
export function entityContract(store: () => Store): void {
  describe('projects', () => {
    it('insert, get, getByName, list, update', () => {
      const s = store();
      s.projects.insert(sampleProject({ id: 'p_2', name: 'b', created_at: at(2) }));
      s.projects.insert(sampleProject({ id: 'p_1', name: 'a', created_at: at(1) }));
      expect(s.projects.get('p_1')?.name).toBe('a');
      expect(s.projects.getByName('b')?.id).toBe('p_2');
      expect(s.projects.get('p_x')).toBeUndefined();
      expect(s.projects.list().map((p) => p.id)).toEqual(['p_1', 'p_2']);
      const p = s.projects.get('p_1')!;
      expect(s.projects.update({ ...p, checks: [{ name: 'lint', cmd: 'pnpm lint' }] })).toBe(true);
      expect(s.projects.get('p_1')?.checks).toEqual([{ name: 'lint', cmd: 'pnpm lint' }]);
      expect(s.projects.update(sampleProject({ id: 'p_9', name: 'z' }))).toBe(false);
    });

    it('rejects duplicate id and name', () => {
      const s = store();
      s.projects.insert(sampleProject());
      expect(() => s.projects.insert(sampleProject())).toThrow(UniqueViolationError);
      expect(() => s.projects.insert(sampleProject({ id: 'p_2' }))).toThrow(UniqueViolationError);
      expect(s.projects.list()).toHaveLength(1);
    });

    it('returns copies', () => {
      const s = store();
      s.projects.insert(sampleProject());
      const p = s.projects.get('p_000001')!;
      p.checks.push({ name: 'x', cmd: 'y' });
      expect(s.projects.get('p_000001')?.checks).toHaveLength(1);
    });
  });

  describe('tasks', () => {
    it('insert, get and list with filters in created_at order', () => {
      const s = store();
      seedParents(s, 'project');
      s.projects.insert(sampleProject({ id: 'p_2', name: 'other' }));
      s.tasks.insert(sampleTask({ id: 't_3', created_at: at(3), status: 'done' }));
      s.tasks.insert(sampleTask({ id: 't_1', created_at: at(1) }));
      s.tasks.insert(
        sampleTask({ id: 't_2', created_at: at(1), project_id: 'p_2', parent_id: 't_1' }),
      );
      expect(s.tasks.list().map((t) => t.id)).toEqual(['t_1', 't_2', 't_3']);
      expect(s.tasks.list({ statuses: ['done'] }).map((t) => t.id)).toEqual(['t_3']);
      expect(s.tasks.list({ project_id: 'p_2' }).map((t) => t.id)).toEqual(['t_2']);
      expect(s.tasks.list({ parent_id: 't_1' }).map((t) => t.id)).toEqual(['t_2']);
      expect(
        s.tasks.list({ statuses: ['queued'], project_id: 'p_000001' }).map((t) => t.id),
      ).toEqual(['t_1']);
      expect(s.tasks.list({ statuses: [] })).toEqual([]);
      expect(() => s.tasks.insert(sampleTask({ id: 't_1' }))).toThrow(UniqueViolationError);
    });

    it('round-trips every field, including arrays and nulls', () => {
      const s = store();
      seedParents(s, 'project');
      const task = sampleTask({
        owned_paths: ['a/', 'b/**/*.ts'],
        blocked_reason: '原因',
        retry_at: at(5),
        fix_notes: '- 修正',
      });
      s.tasks.insert(task);
      expect(s.tasks.get(task.id)).toEqual(task);
    });

    it('update is compare-and-set on version (optimistic lock)', () => {
      const s = store();
      seedParents(s, 'project');
      s.tasks.insert(sampleTask({ version: 1 }));
      const t = s.tasks.get('t_000001')!;
      const stored = s.tasks.update({ ...t, status: 'running', version: 99 }, 1);
      expect(stored?.version).toBe(2);
      expect(stored?.status).toBe('running');
      expect(s.tasks.get('t_000001')?.version).toBe(2);
      // stale writer loses and nothing changes
      expect(s.tasks.update({ ...t, status: 'cancelled' }, 1)).toBeUndefined();
      expect(s.tasks.get('t_000001')?.status).toBe('running');
      // missing row
      expect(s.tasks.update(sampleTask({ id: 't_404' }), 1)).toBeUndefined();
      expect(s.tasks.get('t_404')).toBeUndefined();
    });
  });

  describe('workspaces', () => {
    it('findCurrentByTask ignores removed workspaces', () => {
      const s = store();
      seedParents(s, 'task');
      s.workspaces.insert(sampleWorkspace({ id: 'w_1', state: 'removed', created_at: at(1) }));
      expect(s.workspaces.findCurrentByTask('t_000001')).toBeUndefined();
      s.workspaces.insert(sampleWorkspace({ id: 'w_2', state: 'kept', created_at: at(2) }));
      expect(s.workspaces.findCurrentByTask('t_000001')?.id).toBe('w_2');
      expect(s.workspaces.list({ states: ['removed'] }).map((w) => w.id)).toEqual(['w_1']);
      expect(s.workspaces.list({ task_id: 't_000001' }).map((w) => w.id)).toEqual(['w_1', 'w_2']);
      const w = s.workspaces.get('w_2')!;
      expect(s.workspaces.update({ ...w, head_sha: 'bbbbbbb2' })).toBe(true);
      expect(s.workspaces.get('w_2')?.head_sha).toBe('bbbbbbb2');
      expect(s.workspaces.update(sampleWorkspace({ id: 'w_9' }))).toBe(false);
      expect(() => s.workspaces.insert(sampleWorkspace({ id: 'w_1' }))).toThrow(
        UniqueViolationError,
      );
    });
  });

  describe('runs', () => {
    it('dispatch_id is unique and looked up', () => {
      const s = store();
      seedParents(s);
      s.runs.insert(sampleRun());
      expect(s.runs.getByDispatchId('d_000001')?.id).toBe('r_000001');
      expect(() => s.runs.insert(sampleRun({ id: 'r_2' }))).toThrow(UniqueViolationError);
      expect(() => s.runs.insert(sampleRun({ dispatch_id: 'd_2' }))).toThrow(UniqueViolationError);
      expect(s.runs.list()).toHaveLength(1);
    });

    it('lists by task and state in started_at order; round-trips receipt and usage', () => {
      const s = store();
      seedParents(s);
      s.tasks.insert(sampleTask({ id: 't_2' }));
      s.runs.insert(
        sampleRun({ id: 'r_2', dispatch_id: 'd_2', started_at: at(2), state: 'running' }),
      );
      s.runs.insert(
        sampleRun({ id: 'r_1', dispatch_id: 'd_1', started_at: at(1), state: 'succeeded' }),
      );
      s.runs.insert(
        sampleRun({ id: 'r_3', dispatch_id: 'd_3', task_id: 't_2', started_at: at(0) }),
      );
      expect(s.runs.list({ task_id: 't_000001' }).map((r) => r.id)).toEqual(['r_1', 'r_2']);
      expect(s.runs.list({ states: ['starting', 'running'] }).map((r) => r.id)).toEqual([
        'r_3',
        'r_2',
      ]);
      const run = s.runs.get('r_1')!;
      const receipt = {
        dispatch_id: 'd_1',
        status: 'done' as const,
        summary: 'ok',
        files_changed: ['a.ts'],
        checks: [{ cmd: 'x', result: 'pass' as const, note: '' }],
        needs_leader: '',
      };
      const updated = {
        ...run,
        receipt,
        usage: { input_tokens: 3 },
        cost_usd: 0.5,
        outcome: 'ok' as const,
      };
      expect(s.runs.update(updated)).toBe(true);
      expect(s.runs.get('r_1')).toEqual(updated);
      expect(s.runs.update(sampleRun({ id: 'r_404', dispatch_id: 'd_404' }))).toBe(false);
    });
  });
}
