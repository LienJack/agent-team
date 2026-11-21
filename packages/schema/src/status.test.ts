import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMNS,
  boardColumnOf,
  canTransition,
  canTransitionRun,
  RUN_STATES,
  RUN_TRANSITIONS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TaskStatus,
} from './status.js';

describe('§14 轉換表 — task status transition table', () => {
  it('covers every status and only targets known statuses', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const to of targets) expect(TASK_STATUSES).toContain(to);
    }
  });

  it('follows the main line draft → queued → running → verifying → review → done', () => {
    const line: TaskStatus[] = ['draft', 'queued', 'running', 'verifying', 'review', 'done'];
    for (let i = 0; i < line.length - 1; i++) {
      expect(canTransition(line[i]!, line[i + 1]!)).toBe(true);
    }
  });

  it('has no self-transitions and terminal done/cancelled', () => {
    for (const s of TASK_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(TASK_TRANSITIONS.done).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });

  it('forbids skipping verification or review', () => {
    expect(canTransition('running', 'done')).toBe(false);
    expect(canTransition('running', 'review')).toBe(false);
    expect(canTransition('queued', 'done')).toBe(false);
    expect(canTransition('draft', 'running')).toBe(false);
  });

  it('lets blocked/failed tasks return to their stage or be cancelled', () => {
    for (const s of ['blocked', 'failed'] as const) {
      expect(canTransition(s, 'queued')).toBe(true);
      expect(canTransition(s, 'review')).toBe(true);
      expect(canTransition(s, 'cancelled')).toBe(true);
      expect(canTransition(s, 'done')).toBe(false);
    }
  });
});

describe('run state transitions', () => {
  it('only starting/running are non-terminal', () => {
    for (const s of RUN_STATES) {
      const terminal = RUN_TRANSITIONS[s].length === 0;
      expect(terminal).toBe(s !== 'starting' && s !== 'running');
    }
    expect(canTransitionRun('starting', 'start_unknown')).toBe(true);
    expect(canTransitionRun('running', 'start_unknown')).toBe(false);
  });
});

describe('board columns', () => {
  it('map every status except cancelled to exactly one column', () => {
    const seen = BOARD_COLUMNS.flatMap((c) => [...c.statuses]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(TASK_STATUSES.filter((s) => s !== 'cancelled').sort());
    expect(boardColumnOf('verifying')).toBe('in_progress');
    expect(boardColumnOf('failed')).toBe('blocked');
    expect(boardColumnOf('cancelled')).toBeUndefined();
  });
});
