import { describe, expect, it } from 'vitest';
import { makeRunner } from '../test/fixtures.js';
import { describeRunner, sortRunners } from './runners.js';

const now = Date.parse('2026-11-20T08:00:00.000Z');

describe('describeRunner', () => {
  it('reports an available runner with its quota', () => {
    const view = describeRunner(
      makeRunner({
        quota: {
          utilization: 0.42,
          resets_at: null,
          exhausted: false,
          updated_at: '2026-11-20T07:00:00.000Z',
        },
      }),
      now,
    );
    expect(view).toMatchObject({ label: '可用', tone: 'ok', utilization: 0.42 });
    expect(view.detail).toContain('額度已用 42%');
  });

  it('ranks circuit > exhausted > cooldown > unavailable', () => {
    const cooling = makeRunner({ cooldown_until: '2026-11-20T08:15:00.000Z' });
    expect(describeRunner(cooling, now).label).toBe('冷卻中');
    expect(describeRunner({ ...cooling, available: false }, now).label).toBe('冷卻中');
    expect(describeRunner(makeRunner({ available: false }), now).label).toBe('不可用');
    expect(describeRunner(makeRunner({ circuit: 'open', available: false }), now).label).toBe(
      '熔斷',
    );
    const past = makeRunner({ cooldown_until: '2026-11-20T07:00:00.000Z' });
    expect(describeRunner(past, now).label).toBe('可用');
  });

  it('a runner stopped by the rate-limit loop guard says so and how to re-arm it', () => {
    const halted = makeRunner({
      circuit: 'open',
      available: false,
      rate_limit_loops: 3,
      halted_at: '2026-11-20T07:30:00.000Z',
      halted_attention_id: 'a_9',
    });
    const view = describeRunner(halted, now);
    expect(view).toMatchObject({ label: '已停用', tone: 'bad' });
    expect(view.detail).toContain('冷卻後連續 3 次又撞到額度上限，停止自動恢復');
    expect(view.detail).not.toContain('熔斷到');
  });

  it('orders claude, codex, dsh first', () => {
    const sorted = sortRunners([
      makeRunner({ runner: 'fake' }),
      makeRunner({ runner: 'dsh' }),
      makeRunner({ runner: 'claude' }),
      makeRunner({ runner: 'codex' }),
    ]);
    expect(sorted.map((r) => r.runner)).toEqual(['claude', 'codex', 'dsh', 'fake']);
  });
});
