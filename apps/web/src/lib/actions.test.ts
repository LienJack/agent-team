import { BOARD_COLUMNS, TASK_STATUSES, type TaskStatus } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { actionBlocker, decideDrop, reassignChoices } from './actions.js';

describe('decideDrop — legal drag targets', () => {
  it.each<[TaskStatus, string, string]>([
    ['draft', 'in_progress', 'queue'],
    ['review', 'done', 'approve'],
    ['review', 'pending', 'reject'],
    ['review', 'in_progress', 'reject'],
    ['blocked', 'pending', 'retry'],
    ['failed', 'in_progress', 'retry'],
  ])('%s → %s = %s', (status, target, action) => {
    const decision = decideDrop(status, target as never);
    expect(decision).toMatchObject({ kind: 'action', action });
  });

  it('asks for confirmation only for approve and reject', () => {
    expect(decideDrop('review', 'done')).toMatchObject({ confirm: true });
    expect(decideDrop('review', 'pending')).toMatchObject({ confirm: true });
    expect(decideDrop('draft', 'in_progress')).toMatchObject({ confirm: false });
    expect(decideDrop('failed', 'pending')).toMatchObject({ confirm: false });
  });

  it('does nothing when dropped in its own column or outside', () => {
    expect(decideDrop('draft', 'pending')).toEqual({ kind: 'none' });
    expect(decideDrop('queued', 'pending')).toEqual({ kind: 'none' });
    expect(decideDrop('failed', 'blocked')).toEqual({ kind: 'none' });
    expect(decideDrop('review', undefined)).toEqual({ kind: 'none' });
  });

  it.each<[TaskStatus, string]>([
    ['draft', 'done'],
    ['draft', 'review'],
    ['queued', 'in_progress'],
    ['queued', 'done'],
    ['running', 'done'],
    ['verifying', 'pending'],
    ['review', 'blocked'],
    ['blocked', 'done'],
    ['done', 'pending'],
    ['done', 'review'],
    ['draft', 'blocked'],
  ])('refuses %s → %s with a reason', (status, target) => {
    const decision = decideDrop(status, target as never);
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.reason.length > 0).toBe(true);
  });

  it('never proposes an action for a terminal task, whatever the target', () => {
    for (const column of BOARD_COLUMNS) {
      for (const status of ['done', 'cancelled'] as const) {
        expect(decideDrop(status, column.id).kind).not.toBe('action');
      }
    }
  });

  it('only proposes actions whose button would be enabled', () => {
    const proposed = TASK_STATUSES.flatMap((status) =>
      BOARD_COLUMNS.map((column) => ({ status, decision: decideDrop(status, column.id) })),
    ).filter((p) => p.decision.kind === 'action');
    expect(proposed.length).toBeGreaterThan(0);
    const blockers = proposed.map(({ status, decision }) =>
      decision.kind === 'action'
        ? actionBlocker({ status, current_run_id: null }, decision.action)
        : 'not an action',
    );
    expect(blockers.every((b) => b === undefined)).toBe(true);
  });
});

describe('actionBlocker — drawer buttons', () => {
  const task = (status: TaskStatus, current_run_id: string | null = null) => ({
    status,
    current_run_id,
  });

  it('enables each action only in its states', () => {
    expect(actionBlocker(task('draft'), 'queue')).toBeUndefined();
    expect(actionBlocker(task('queued'), 'queue')).toBeDefined();
    expect(actionBlocker(task('blocked'), 'retry')).toBeUndefined();
    expect(actionBlocker(task('running'), 'retry')).toBeDefined();
    expect(actionBlocker(task('review'), 'approve')).toBeUndefined();
    expect(actionBlocker(task('review'), 'reject')).toBeUndefined();
    expect(actionBlocker(task('done'), 'approve')).toBeDefined();
    expect(actionBlocker(task('running', 'r_1'), 'cancel')).toBeUndefined();
    expect(actionBlocker(task('done'), 'cancel')).toBeDefined();
  });

  it('allows reassign only without a run in flight', () => {
    expect(actionBlocker(task('queued'), 'reassign')).toBeUndefined();
    expect(actionBlocker(task('failed'), 'reassign')).toBeUndefined();
    expect(actionBlocker(task('running', 'r_1'), 'reassign')).toBeDefined();
    expect(actionBlocker(task('verifying'), 'reassign')).toBeDefined();
    expect(actionBlocker(task('cancelled'), 'reassign')).toBeDefined();
  });

  it('a research task (spec §17) can be queued, retried and cancelled, never reviewed or reassigned', () => {
    const research = (status: TaskStatus) => ({ ...task(status), kind: 'research' as const });
    expect(actionBlocker(research('draft'), 'queue')).toBeUndefined();
    expect(actionBlocker(research('failed'), 'retry')).toBeUndefined();
    expect(actionBlocker(research('running'), 'cancel')).toBeUndefined();
    expect(actionBlocker(research('review'), 'approve')).toBe('調研任務沒有驗收，完成後直接結束');
    expect(actionBlocker(research('review'), 'reject')).toBeDefined();
    expect(actionBlocker(research('queued'), 'reassign')).toBe(
      '調研任務的角色固定（oss_researcher）',
    );
    expect(actionBlocker({ ...task('queued'), kind: 'impl' }, 'reassign')).toBeUndefined();
  });
});

describe('reassignChoices — the picker lists GET /api/roles', () => {
  const role = (name: string, enabled = true) => ({
    name,
    model_alias: 'opus',
    runner: 'claude',
    enabled,
  });

  it('enabled roles only, implementation roles first, the current role always present', () => {
    const { impl, other } = reassignChoices(
      [role('planner'), role('impl_A'), role('gate', false), role('impl_C')],
      'impl_C',
    );
    expect(impl.map((r) => r.name)).toEqual(['impl_A', 'impl_C']);
    expect(other.map((r) => r.name)).toEqual(['planner']);
    expect(impl[0]!.label).toBe('impl_A — opus（claude）');
  });

  it('falls back to impl_A/B/C while the roles are not loaded', () => {
    const { impl, other } = reassignChoices(undefined, 'researcher');
    expect(impl.map((r) => r.name)).toEqual(['impl_A', 'impl_B', 'impl_C']);
    expect(other.map((r) => r.name)).toEqual(['researcher']);
  });
});
