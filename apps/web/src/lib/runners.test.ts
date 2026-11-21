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
