import { describe, expect, it } from 'vitest';
import {
  boardSummary,
  deliveriesReport,
  deliveryOf,
  deliveryReport,
  refusedDelivery,
  refusedReport,
  type Delivery,
  type ReportedTask,
} from './delivery.js';
import { TASK_STATUSES, type TaskStatus } from './status.js';
import type { TaskWaiting } from './waiting.js';

// docs/adr/0022 §1: what happened to a task's dispatch, derived from stored state, and the
// one-line report the leader relays.

const task = (status: TaskStatus, over: Partial<ReportedTask> = {}) => ({
  id: 't_000001',
  title: '加一個功能',
  kind: 'impl' as const,
  status,
  blocked_reason: status === 'blocked' ? '審查回報 blocked：缺少金鑰' : null,
  current_run_id: ['running', 'verifying', 'review'].includes(status) ? 'r_000001' : null,
  ...over,
});
const slot: TaskWaiting = {
  reason: 'no_slot',
  detail: 'role impl_C',
  blocking_task_id: null,
  retry_at: null,
};

describe('deliveryOf', () => {
  it('maps every task status (exhaustive)', () => {
    const states = Object.fromEntries(
      TASK_STATUSES.map((s) => {
        const live = ['running', 'review'].includes(s) ? 'r_000001' : null;
        return [s, deliveryOf({ task: task(s), liveRunId: live, waiting: null }).state];
      }),
    );
    expect(states).toEqual({
      draft: 'draft',
      queued: 'queued',
      running: 'running',
      verifying: 'running',
      review: 'running',
      done: 'done',
      blocked: 'not_accepted',
      failed: 'not_accepted',
      cancelled: 'not_accepted',
    });
  });

  it('is running only with a live run; without one it is queued with the waiting reason', () => {
    expect(deliveryOf({ task: task('running'), liveRunId: 'r_000001', waiting: null })).toEqual({
      state: 'running',
      waiting: null,
      run_id: 'r_000001',
      reason: null,
    });
    // a review task before its review run starts is waiting, not running
    expect(deliveryOf({ task: task('review'), liveRunId: null, waiting: slot })).toMatchObject({
      state: 'queued',
      waiting: slot,
    });
    expect(deliveryOf({ task: task('queued'), liveRunId: null, waiting: slot }).waiting).toEqual(
      slot,
    );
  });

  it('a blocked task says why nothing runs', () => {
    expect(deliveryOf({ task: task('blocked'), liveRunId: null, waiting: null })).toMatchObject({
      state: 'not_accepted',
      reason: '審查回報 blocked：缺少金鑰',
    });
  });
});

describe('deliveryReport', () => {
  const report = (status: TaskStatus, d: Delivery, over: Partial<ReportedTask> = {}) =>
    deliveryReport(task(status, over), d);

  it('never says running, started or in progress unless the delivery is running', () => {
    for (const status of TASK_STATUSES) {
      for (const waiting of [null, slot]) {
        const live = ['running', 'review'].includes(status) ? 'r_000001' : null;
        const d = deliveryOf({ task: task(status), liveRunId: live, waiting });
        const line = deliveryReport(task(status), d);
        expect(line).not.toContain('\n');
        expect(/正在|已開始|執行中/.test(line)).toBe(d.state === 'running');
      }
    }
  });

  it('says exactly what the delivery says', () => {
    expect(
      report('queued', deliveryOf({ task: task('queued'), liveRunId: null, waiting: slot })),
    ).toBe('任務 t_000001「加一個功能」已排入佇列，尚未開始執行（執行槽位已滿）。');
    expect(
      report('queued', deliveryOf({ task: task('queued'), liveRunId: null, waiting: null })),
    ).toBe('任務 t_000001「加一個功能」已排入佇列，尚未開始執行（等待排程）。');
    const overlap: TaskWaiting = {
      reason: 'path_overlap',
      detail: null,
      blocking_task_id: 't_000009',
      retry_at: null,
    };
    expect(
      report('queued', deliveryOf({ task: task('queued'), liveRunId: null, waiting: overlap })),
    ).toContain('owned_paths 與進行中的任務 t_000009 重疊');
    const research = { kind: 'research' as const, title: '調研：佇列' };
    expect(
      report(
        'running',
        deliveryOf({ task: task('running'), liveRunId: 'r_000001', waiting: null }),
        research,
      ),
    ).toBe('調研任務 t_000001「調研：佇列」正在執行（run r_000001）。');
    expect(
      report('verifying', deliveryOf({ task: task('verifying'), liveRunId: null, waiting: null })),
    ).toBe('任務 t_000001「加一個功能」的 worker 已交回執，服務端正在核對（run r_000001）。');
    expect(
      report('cancelled', deliveryOf({ task: task('cancelled'), liveRunId: null, waiting: null })),
    ).toBe('任務 t_000001「加一個功能」已取消，不會執行。');
    // a title with line breaks stays on one line
    expect(
      deliveryReport(task('done', { title: '第一行\n第二行' }), {
        state: 'done',
        waiting: null,
        run_id: null,
        reason: null,
      }),
    ).toBe('任務 t_000001「第一行 第二行」已完成。');
  });

  it('a refused request: nothing was created; an unreachable service: not known', () => {
    expect(refusedDelivery('conflict: x')).toEqual({
      state: 'not_accepted',
      waiting: null,
      run_id: null,
      reason: 'conflict: x',
    });
    expect(refusedReport('conflict', 'only blocked or failed tasks can be retried', true)).toBe(
      '請求未被受理（conflict）：only blocked or failed tasks can be retried。沒有建立或改變任何任務。',
    );
    expect(refusedReport('unavailable', 'connection refused', false)).toMatch(
      /^無法連線到服務（connection refused），無法確認請求是否已受理/,
    );
  });
});

describe('deliveriesReport (several results)', () => {
  it('counts per state that sum to the total', () => {
    const results = (
      [
        ['queued', null],
        ['queued', null],
        ['running', 'r_1'],
        ['draft', null],
        ['blocked', null],
      ] as const
    ).map(([status, live], i) => {
      const t = task(status, { id: `t_00000${i}` });
      return { task: t, delivery: deliveryOf({ task: t, liveRunId: live, waiting: null }) };
    });
    const line = deliveriesReport(results);
    expect(line).toBe('共 5 個任務：執行中 1、排隊中（尚未執行） 2、草稿 1、不會執行 1。');
    const sum = [...line.matchAll(/ (\d+)(?=、|。)/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(sum).toBe(results.length);
    // one result reads like a single command
    expect(deliveriesReport(results.slice(2, 3))).toBe(
      deliveryReport(results[2]!.task, results[2]!.delivery),
    );
  });
});

describe('boardSummary', () => {
  it('columns sum to the total; cancelled tasks are counted apart', () => {
    const statuses: TaskStatus[] = [...TASK_STATUSES, 'queued', 'done', 'cancelled'];
    const s = boardSummary(statuses.map((status) => ({ status })));
    expect(s.total).toBe(statuses.length - 2);
    expect(Object.values(s.columns).reduce((a, b) => a + b, 0)).toBe(s.total);
    expect(s).toMatchObject({
      columns: { pending: 3, in_progress: 2, review: 1, blocked: 2, done: 2 },
      drafts: 1,
      queued: 2,
      cancelled: 2,
    });
    expect(s.report).toBe(
      '看板共 10 個任務：待派 3（草稿 1、排隊 2，都尚未執行）、進行中 2、待驗收 1、阻塞 2、完成 2；另有 2 個已取消（不在看板上）。',
    );
    expect(boardSummary([]).report).toBe(
      '看板共 0 個任務：待派 0（草稿 0、排隊 0，都尚未執行）、進行中 0、待驗收 0、阻塞 0、完成 0。',
    );
  });
});
