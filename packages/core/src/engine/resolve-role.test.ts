import type { RunnerHealth } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { testModelsConfig } from '../testing/fixtures.js';
import { resolveRole, type QuotaState } from './resolve-role.js';

const NOW = new Date('2026-11-21T00:00:00.000Z');
const LATER = '2026-11-21T01:00:00.000Z';
const models = testModelsConfig();

function health(runner: 'claude' | 'codex' | 'dsh', patch: Partial<RunnerHealth> = {}) {
  return {
    runner,
    cooldown_until: null,
    cooldown_reason: null,
    consecutive_failures: 0,
    circuit_open_until: null,
    rate_limit_loops: 0,
    probe_after_cooldown: false,
    halted_at: null,
    halted_attention_id: null,
    quota: null,
    available: true,
    ...patch,
  };
}

function state(
  patch: Partial<
    Record<'claude' | 'codex' | 'dsh', Partial<RunnerHealth> & { available?: boolean }>
  > = {},
): QuotaState {
  return {
    claude: health('claude', patch.claude),
    codex: health('codex', patch.codex),
    dsh: health('dsh', patch.dsh),
  };
}

const quota = (utilization: number, exhausted = false) => ({
  utilization,
  resets_at: LATER,
  exhausted,
  updated_at: NOW.toISOString(),
});

describe('resolveRole', () => {
  it('uses the primary alias with its model and effort', () => {
    const r = resolveRole('impl_A', state(), { models, now: NOW });
    expect(r).toMatchObject({
      ok: true,
      alias: 'opus',
      runner: 'claude',
      model: 'claude-opus',
      effort: 'high',
      via: 'use',
    });
  });

  it('falls back in order when the primary runner cools down (cooldown → reassignment)', () => {
    const r = resolveRole('impl_B', state({ codex: { cooldown_until: LATER } }), {
      models,
      now: NOW,
    });
    expect(r).toMatchObject({
      ok: true,
      alias: 'kimi-pro',
      runner: 'dsh',
      via: 'fallback',
      skipped: [{ alias: 'gpt-sol', reason: 'cooldown' }],
    });
    expect(
      resolveRole('impl_B', state({ codex: { cooldown_until: '2026-11-20T00:00:00.000Z' } }), {
        models,
        now: NOW,
      }),
    ).toMatchObject({ alias: 'gpt-sol' });
  });

  it('skips open circuits, exhausted quota and unavailable runners; reports the earliest retry', () => {
    const r = resolveRole(
      'impl_B',
      state({
        codex: { circuit_open_until: LATER },
        dsh: { quota: quota(1, true) },
        claude: { cooldown_until: '2026-11-21T00:30:00.000Z' },
      }),
      { models, now: NOW },
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'no_candidate',
      retryAt: '2026-11-21T00:30:00.000Z',
    });
    expect(r.skipped.map((s) => s.reason)).toEqual(['circuit_open', 'quota_exhausted', 'cooldown']);
    expect(
      resolveRole('impl_C', state({ dsh: { available: false } }), { models, now: NOW }),
    ).toMatchObject({
      ok: false,
      retryAt: null,
    });
  });

  it('skips runners that are not registered', () => {
    const r = resolveRole('impl_C', { claude: health('claude') }, { models, now: NOW });
    expect(r).toMatchObject({ ok: false, reason: 'no_candidate' });
  });

  it('applies rules.quota.when_claude_high at the utilization threshold', () => {
    expect(
      resolveRole('review_B', state({ claude: { quota: quota(0.69) } }), { models, now: NOW }),
    ).toMatchObject({
      alias: 'sonnet',
    });
    expect(
      resolveRole('review_B', state({ claude: { quota: quota(0.7) } }), { models, now: NOW }),
    ).toMatchObject({
      alias: 'gpt-astra',
      via: 'when_claude_high',
    });
  });

  it('applies rules.quota.codex_low_quota when codex is low or exhausted', () => {
    expect(
      resolveRole('impl_B', state({ codex: { quota: quota(0.85) } }), { models, now: NOW }),
    ).toMatchObject({
      alias: 'kimi-pro',
      via: 'codex_low_quota',
    });
    expect(
      resolveRole('impl_B', state({ codex: { quota: quota(0.5) } }), { models, now: NOW }),
    ).toMatchObject({
      alias: 'gpt-sol',
    });
  });

  it('excludes the implementer alias for reviewers (impl_B and review_C both on gpt-sol)', () => {
    const impl = resolveRole('impl_B', state(), { models, now: NOW });
    expect(impl).toMatchObject({ alias: 'gpt-sol' });
    const review = resolveRole('review_C', state(), {
      models,
      now: NOW,
      excludeAliases: ['gpt-sol'],
    });
    expect(review).toMatchObject({ ok: true, alias: 'kimi-pro' });
  });

  it('excludes the implementer even when codex_low_quota maps both roles to kimi-pro', () => {
    const low = state({ codex: { quota: quota(0.95) } });
    const impl = resolveRole('impl_B', low, { models, now: NOW });
    expect(impl).toMatchObject({ alias: 'kimi-pro', via: 'codex_low_quota' });
    const review = resolveRole('review_C', low, { models, now: NOW, excludeAliases: ['kimi-pro'] });
    expect(review).toMatchObject({ ok: true, alias: 'gpt-sol' });
    expect(review.skipped).toEqual([{ alias: 'kimi-pro', reason: 'excluded' }]);
  });

  it('reports unknown and disabled roles, and never picks the jev judgement endpoint', () => {
    expect(resolveRole('nope', state(), { models, now: NOW })).toMatchObject({
      ok: false,
      reason: 'unknown_role',
    });
    expect(resolveRole('gate', state(), { models, now: NOW })).toMatchObject({
      ok: false,
      reason: 'role_disabled',
    });
    const withJev = testModelsConfig((m) => {
      m.roles['gate'] = { use: 'jev', fallback: ['deepseek-flash'], slots: 1 };
    });
    const r = resolveRole('gate', state(), { models: withJev, now: NOW });
    expect(r).toMatchObject({
      ok: true,
      alias: 'deepseek-flash',
      skipped: [{ alias: 'jev', reason: 'not_a_text_runner' }],
    });
  });
});
