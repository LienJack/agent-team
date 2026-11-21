import type { BoardTask } from '@agent-team/client';
import { describe, expect, it } from 'vitest';
import { makeBoardTask, makeRun, makeTask } from '../test/fixtures.js';
import { groupTasks, latestReceiptRun, latestReviewRun, summarizeTask } from './board.js';

describe('groupTasks', () => {
  it('puts each status in its spec §5 column and hides cancelled tasks', () => {
    const tasks = [
      makeTask({ id: 't_d', status: 'draft' }),
      makeTask({ id: 't_q', status: 'queued' }),
      makeTask({ id: 't_r', status: 'running' }),
      makeTask({ id: 't_v', status: 'verifying' }),
      makeTask({ id: 't_rv', status: 'review' }),
      makeTask({ id: 't_b', status: 'blocked' }),
      makeTask({ id: 't_f', status: 'failed' }),
      makeTask({ id: 't_ok', status: 'done' }),
      makeTask({ id: 't_x', status: 'cancelled' }),
    ];
    const cols = groupTasks(tasks);
    const ids = (k: keyof typeof cols) => cols[k].map((t) => t.id).sort();
    expect(ids('pending')).toEqual(['t_d', 't_q']);
    expect(ids('in_progress')).toEqual(['t_r', 't_v']);
    expect(ids('review')).toEqual(['t_rv']);
    expect(ids('blocked')).toEqual(['t_b', 't_f']);
    expect(ids('done')).toEqual(['t_ok']);
  });

  it('orders 待派 by dispatch order, then drafts, and filters by project', () => {
    const cols = groupTasks(
      [
        makeTask({ id: 'draft', status: 'draft' }),
        makeTask({ id: 'late', status: 'queued', created_at: '2026-11-20T09:00:00.000Z' }),
        makeTask({ id: 'early', status: 'queued', created_at: '2026-11-20T08:00:00.000Z' }),
        makeTask({ id: 'urgent', status: 'queued', priority: 5 }),
        makeTask({ id: 'other', status: 'queued', project_id: 'p_other' }),
      ],
      'p_demo',
    );
    expect(cols.pending.map((t) => t.id)).toEqual(['urgent', 'early', 'late', 'draft']);
  });
});

describe('summarizeTask — card fields straight from the snapshot', () => {
  const now = Date.parse('2026-11-20T08:10:00.000Z');
  const run = (over: Partial<NonNullable<BoardTask['latest_run']>> = {}) => ({
    id: 'r_2',
    kind: 'review' as const,
    role: 'review_C',
    model_alias: 'gpt-sol',
    runner: 'codex' as const,
    state: 'succeeded' as const,
    cost_usd: 0.05,
    cost_estimated: false,
    usage: null,
    started_at: '2026-11-20T08:03:00.000Z',
    ended_at: '2026-11-20T08:04:00.000Z',
    ...over,
  });

  it('shows the latest run, the run totals and the head sha', () => {
    const s = summarizeTask(
      makeBoardTask({
        status: 'done',
        latest_run: run(),
        head_sha: 'abcdef1234',
        run_totals: {
          runs: 2,
          cost_usd: 0.15,
          cost_estimated: false,
          usage: { input_tokens: 1000, output_tokens: 200 },
          finished_ms: 180_000,
        },
      }),
      now,
    );
    expect(s.executor).toBe('gpt-sol');
    expect(s.executorDetail).toBe('review · review_C · codex');
    expect(s.elapsedMs).toBe(180_000);
    expect(s.costUsd).toBeCloseTo(0.15);
    expect(s.tokens).toBe(1200);
    expect(s.commit).toBe('abcdef1234');
    expect(s.liveSince).toBeUndefined();
  });

  it('counts a live run until now', () => {
    const s = summarizeTask(
      makeBoardTask({
        status: 'running',
        latest_run: run({
          kind: 'impl',
          model_alias: 'deepseek-flash',
          state: 'running',
          started_at: '2026-11-20T08:09:00.000Z',
          ended_at: null,
          cost_usd: null,
        }),
        run_totals: {
          runs: 2,
          cost_usd: null,
          cost_estimated: false,
          usage: {},
          finished_ms: 30_000,
        },
      }),
      now,
    );
    expect(s.executor).toBe('deepseek-flash');
    expect(s.liveSince).toBe('2026-11-20T08:09:00.000Z');
    expect(s.elapsedMs).toBe(90_000);
    expect(s.costUsd).toBeNull();
  });

  it('is empty before the first run', () => {
    const s = summarizeTask(makeBoardTask(), now);
    expect(s.executor).toBeUndefined();
    expect(s.elapsedMs).toBeUndefined();
    expect(s.commit).toBeNull();
  });
});

describe('receipt pickers', () => {
  it('finds the latest receipt and the latest review', () => {
    const impl = makeRun({
      id: 'r_impl',
      receipt: {
        dispatch_id: 'd',
        status: 'done',
        summary: 's',
        files_changed: [],
        checks: [],
        needs_leader: '',
      },
    });
    const review = makeRun({
      id: 'r_rev',
      kind: 'review',
      started_at: '2026-11-20T08:05:00.000Z',
      receipt: { dispatch_id: 'd2', verdict: 'pass', summary: 'ok', findings: [] },
    });
    const noReceipt = makeRun({ id: 'r_none', started_at: '2026-11-20T09:00:00.000Z' });
    expect(latestReceiptRun([impl, review, noReceipt])?.id).toBe('r_rev');
    expect(latestReviewRun([impl, noReceipt])).toBeUndefined();
  });
});
