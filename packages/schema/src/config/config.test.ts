import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultServiceConfig, parseServiceConfig, ServiceConfigSchema } from './service.js';
import { ModelsConfigSchema, parseModelsConfig, type ModelsConfigInput } from './models.js';

const repoFile = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), 'utf8'));

function minimalModels(): ModelsConfigInput {
  const role = (use: string) => ({ use, fallback: [], slots: 1 });
  return {
    models: { a: { runner: 'claude', model: 'm-a' }, b: { runner: 'codex', model: 'm-b' } },
    roles: {
      impl_A: { ...role('a'), escalate_to: null },
      impl_B: { ...role('a'), escalate_to: 'impl_A' },
      impl_C: { ...role('b'), escalate_to: 'impl_B' },
      review_A: role('b'),
      review_B: role('b'),
      review_C: role('a'),
    },
    rules: {
      max_fix_rounds_before_escalate: 2,
      reviewer_must_differ_from_implementer: true,
      machine_checks_before_model_review: true,
      quota: { claude_high_utilization: 0.7 },
    },
  };
}

describe('config/models.json', () => {
  it('parses against ModelsConfigSchema', () => {
    const cfg = parseModelsConfig(repoFile('config/models.json'));
    expect(cfg.roles['impl_C']?.escalate_to).toBe('impl_B');
    expect(cfg.roles['gate']?.enabled).toBe(false);
    expect(cfg.roles['leader']?.enabled).toBe(true);
    expect(cfg.models['jev']?.price).toBeNull();
    expect(cfg.models['deepseek-flash']?.effort).toBeUndefined();
    expect(cfg.rules.quota.codex_low_utilization).toBe(0.8);
  });

  it('oss_researcher (spec §17) uses only runners that can run web-only research runs', () => {
    const cfg = parseModelsConfig(repoFile('config/models.json'));
    const role = cfg.roles['oss_researcher']!;
    expect(role).toMatchObject({ use: 'sonnet', slots: 2, enabled: true });
    expect(role.fallback[0]).toBe('gpt-sol');
    for (const alias of [role.use, ...role.fallback]) {
      expect(['claude', 'codex']).toContain(cfg.models[alias]?.runner);
    }
    // the older code-reading role is untouched
    expect(cfg.roles['researcher']).toMatchObject({ use: 'deepseek-flash', slots: 4 });
  });

  it('fills defaults for a minimal config', () => {
    const cfg = parseModelsConfig(minimalModels());
    expect(cfg.rules.quota.when_claude_high).toEqual({});
    expect(cfg.roles['impl_A']?.enabled).toBe(true);
  });

  it('rejects unknown aliases, unknown roles, missing required roles and cycles', () => {
    const bad = minimalModels();
    bad.roles['impl_A'] = {
      use: 'nope',
      fallback: ['b', 'ghost'],
      slots: 1,
      escalate_to: 'impl_C',
    };
    delete bad.roles['review_C'];
    bad.rules.quota.when_claude_high = { impl_X: 'a', impl_B: 'zzz' };
    const result = ModelsConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        'required role "review_C" is missing',
        'unknown model alias "nope"',
        'unknown model alias "ghost"',
        'unknown role "impl_X"',
        'unknown model alias "zzz"',
        expect.stringContaining('escalation cycle'),
      ]),
    );
  });

  it('rejects typos in entries (strict objects)', () => {
    const bad = minimalModels() as Record<string, unknown> & ModelsConfigInput;
    (bad.roles['impl_A'] as Record<string, unknown>)['fallbak'] = [];
    expect(ModelsConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe('config/service.json', () => {
  it('parses and equals the schema defaults', () => {
    const cfg = parseServiceConfig(repoFile('config/service.json'));
    expect(cfg).toEqual(defaultServiceConfig());
  });

  it('has the spec defaults', () => {
    const cfg = defaultServiceConfig();
    expect(cfg.local).toEqual({ host: '127.0.0.1', port: 4517 });
    expect(cfg.lan).toEqual({ enabled: true, host: '0.0.0.0', port: 4518 });
    expect(cfg.grok.enabled).toBe(false);
    expect(cfg.engine.rate_limit_cooldown_ms).toBe(15 * 60 * 1000);
    expect(cfg.engine.retry_initial_ms).toBe(5000);
    expect(cfg.engine.retry_max_ms).toBe(5 * 60 * 1000);
    expect(cfg.engine.circuit_failure_threshold).toBe(3);
    expect(cfg.engine.worktree_retention_hours).toBe(72);
    expect(cfg.leader.compact_threshold_tokens).toBe(60000);
    expect(cfg.sse.heartbeat_ms).toBe(15000);
    expect(cfg.paths.worktree_root).toBe('~/RanoLabs/worktrees');
    expect(cfg.git.author).toEqual({ name: 'agent-team', email: 'agent-team@localhost' });
  });

  it('allows port 0 (OS-assigned) and a custom commit author', () => {
    const cfg = parseServiceConfig({
      local: { port: 0 },
      lan: { port: 0 },
      git: { author: { name: 'Team Bot', email: 'bot@example.invalid' } },
    });
    expect([cfg.local.port, cfg.lan.port]).toEqual([0, 0]);
    expect(cfg.git.author.name).toBe('Team Bot');
    expect(ServiceConfigSchema.safeParse({ local: { port: -1 } }).success).toBe(false);
    expect(ServiceConfigSchema.safeParse({ git: { author: { email: 'x' } } }).success).toBe(false);
  });

  it('accepts partial files and rejects unknown keys', () => {
    expect(parseServiceConfig({ lan: { enabled: false } }).lan.port).toBe(4518);
    expect(ServiceConfigSchema.safeParse({ lan: { enabeld: false } }).success).toBe(false);
    // the LAN login and origin settings are gone (docs/adr/0024): an old file says so at start-up
    for (const [key, value] of [
      ['lockout_failures', 5],
      ['lockout_minutes', 15],
      ['session_hours', 168],
      ['allowed_origins', []],
    ] as const) {
      expect(ServiceConfigSchema.safeParse({ lan: { [key]: value } }).success).toBe(false);
    }
  });
});
