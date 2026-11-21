import { describe, expect, it } from 'vitest';
import { ForeignKeyViolationError, UniqueViolationError } from '../../errors.js';
import type { Store } from '../../ports/repositories.js';
import {
  sampleAttention,
  sampleOutbox,
  sampleProject,
  sampleRun,
  sampleTask,
  sampleWorkspace,
} from '../fixtures.js';
import { seedParents } from './entities.js';

/**
 * Referential integrity (docs/adr/0007): foreign keys on insert and update, and at most one
 * non-removed workspace per task. Writes that fail store nothing.
 */
export function integrityContract(store: () => Store): void {
  describe('foreign keys', () => {
    it('rejects inserts whose parent row is missing', () => {
      const s = store();
      expect(() => s.tasks.insert(sampleTask())).toThrow(ForeignKeyViolationError);
      s.projects.insert(sampleProject());
      expect(() => s.tasks.insert(sampleTask({ parent_id: 't_404' }))).toThrow(
        ForeignKeyViolationError,
      );
      expect(() => s.tasks.insert(sampleTask({ current_run_id: 'r_404' }))).toThrow(
        ForeignKeyViolationError,
      );
      expect(s.tasks.list()).toEqual([]);
      expect(() => s.workspaces.insert(sampleWorkspace())).toThrow(ForeignKeyViolationError);
      s.tasks.insert(sampleTask());
      expect(() => s.runs.insert(sampleRun())).toThrow(ForeignKeyViolationError); // no workspace
      s.workspaces.insert(sampleWorkspace());
      expect(() => s.runs.insert(sampleRun({ task_id: 't_404' }))).toThrow(
        ForeignKeyViolationError,
      );
      expect(() => s.attention.insert(sampleAttention({ task_id: 't_404' }))).toThrow(
        ForeignKeyViolationError,
      );
      expect(() => s.outbox.insert(sampleOutbox({ task_id: 't_404' }))).toThrow(
        ForeignKeyViolationError,
      );
      expect(s.runs.list()).toEqual([]);
      expect(s.attention.list()).toEqual([]);
      expect(s.outbox.list()).toEqual([]);
    });

    it('accepts null references and parents that exist', () => {
      const s = store();
      seedParents(s);
      s.tasks.insert(sampleTask({ id: 't_2', parent_id: 't_000001' }));
      s.runs.insert(sampleRun());
      const t = s.tasks.get('t_000001')!;
      expect(s.tasks.update({ ...t, current_run_id: 'r_000001' }, t.version)?.current_run_id).toBe(
        'r_000001',
      );
      s.attention.insert(sampleAttention({ id: 'a_1', task_id: null }));
      s.attention.insert(sampleAttention({ id: 'a_2', task_id: 't_2' }));
      s.outbox.insert(sampleOutbox({ id: 'o_1', signature: 's1', task_id: null }));
      s.outbox.insert(sampleOutbox({ id: 'o_2', signature: 's2', task_id: 't_2' }));
      expect(s.attention.list()).toHaveLength(2);
      expect(s.outbox.list()).toHaveLength(2);
    });

    it('rejects updates that point at a missing row and keeps the stored row', () => {
      const s = store();
      seedParents(s);
      s.runs.insert(sampleRun());
      s.attention.insert(sampleAttention({ task_id: 't_000001' }));
      s.outbox.insert(sampleOutbox({ task_id: 't_000001' }));
      const t = s.tasks.get('t_000001')!;
      expect(() => s.tasks.update({ ...t, project_id: 'p_404' }, t.version)).toThrow(
        ForeignKeyViolationError,
      );
      expect(() => s.tasks.update({ ...t, current_run_id: 'r_404' }, t.version)).toThrow(
        ForeignKeyViolationError,
      );
      expect(s.tasks.get('t_000001')).toEqual(t);
      const w = s.workspaces.get('w_000001')!;
      expect(() => s.workspaces.update({ ...w, task_id: 't_404' })).toThrow(
        ForeignKeyViolationError,
      );
      const r = s.runs.get('r_000001')!;
      expect(() => s.runs.update({ ...r, workspace_id: 'w_404' })).toThrow(
        ForeignKeyViolationError,
      );
      const a = s.attention.get('a_000001')!;
      expect(() => s.attention.update({ ...a, task_id: 't_404' })).toThrow(
        ForeignKeyViolationError,
      );
      const o = s.outbox.get('o_000001')!;
      expect(() => s.outbox.update({ ...o, task_id: 't_404' })).toThrow(ForeignKeyViolationError);
      expect(s.runs.get('r_000001')).toEqual(r);
      expect(s.workspaces.get('w_000001')).toEqual(w);
    });

    it('a violation inside atomic() rolls back the whole transaction', () => {
      const s = store();
      s.projects.insert(sampleProject());
      expect(() =>
        s.atomic((tx) => {
          tx.tasks.insert(sampleTask());
          tx.workspaces.insert(sampleWorkspace({ task_id: 't_404' }));
        }),
      ).toThrow(ForeignKeyViolationError);
      expect(s.tasks.list()).toEqual([]);
    });
  });

  describe('one non-removed workspace per task', () => {
    it('rejects a second active or kept workspace; removed ones do not count', () => {
      const s = store();
      seedParents(s, 'task');
      s.workspaces.insert(sampleWorkspace({ id: 'w_1', state: 'removed' }));
      s.workspaces.insert(sampleWorkspace({ id: 'w_2', state: 'removed' }));
      s.workspaces.insert(sampleWorkspace({ id: 'w_3', state: 'active' }));
      expect(() => s.workspaces.insert(sampleWorkspace({ id: 'w_4', state: 'active' }))).toThrow(
        UniqueViolationError,
      );
      expect(() => s.workspaces.insert(sampleWorkspace({ id: 'w_5', state: 'kept' }))).toThrow(
        UniqueViolationError,
      );
      // another task may have its own
      s.tasks.insert(sampleTask({ id: 't_2' }));
      s.workspaces.insert(sampleWorkspace({ id: 'w_6', task_id: 't_2' }));
      expect(s.workspaces.list().map((w) => w.id)).toEqual(['w_1', 'w_2', 'w_3', 'w_6']);
    });

    it('applies to updates too', () => {
      const s = store();
      seedParents(s, 'task');
      s.workspaces.insert(sampleWorkspace({ id: 'w_1', state: 'removed' }));
      s.workspaces.insert(sampleWorkspace({ id: 'w_2', state: 'active' }));
      const old = s.workspaces.get('w_1')!;
      expect(() => s.workspaces.update({ ...old, state: 'kept' })).toThrow(UniqueViolationError);
      expect(s.workspaces.get('w_1')?.state).toBe('removed');
      // updating the current one itself is fine, and so is reviving after removal
      const cur = s.workspaces.get('w_2')!;
      expect(s.workspaces.update({ ...cur, state: 'kept' })).toBe(true);
      expect(s.workspaces.update({ ...cur, state: 'removed' })).toBe(true);
      expect(s.workspaces.update({ ...old, state: 'active' })).toBe(true);
      expect(s.workspaces.findCurrentByTask('t_000001')?.id).toBe('w_1');
    });
  });
}
