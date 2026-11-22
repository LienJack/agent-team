import { z } from 'zod';
import { EffortSchema, ModelAliasSchema, ModelRunnerSchema, RoleNameSchema } from '../common.js';

/** One model alias in `config/models.json` `models`. */
export const ModelEntrySchema = z.strictObject({
  runner: ModelRunnerSchema,
  model: z.string().min(1),
  effort: EffortSchema.optional(),
  /** USD per million tokens [input, output]; null when not priced (e.g. jev). */
  price: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).nullable().optional(),
  evidence: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

/** One role in `config/models.json` `roles`. */
export const RoleEntrySchema = z.strictObject({
  use: ModelAliasSchema,
  fallback: z.array(ModelAliasSchema).default([]),
  /** Max concurrent runs of this role. */
  slots: z.number().int().nonnegative(),
  desc: z.string().optional(),
  /** Role that takes over after `max_fix_rounds_before_escalate`; null = nowhere to go. */
  escalate_to: RoleNameSchema.nullable().optional(),
  /** Disabled roles never resolve (e.g. the jev gate). */
  enabled: z.boolean().default(true),
});
export type RoleEntry = z.infer<typeof RoleEntrySchema>;

export const QuotaRulesSchema = z.strictObject({
  /** Claude utilization (0..1) at or above which `when_claude_high` applies. */
  claude_high_utilization: z.number().min(0).max(1),
  /** role → alias to prefer while Claude is high. */
  when_claude_high: z.record(RoleNameSchema, ModelAliasSchema).default({}),
  /** role → alias to prefer while Codex quota is low. */
  codex_low_quota: z.record(RoleNameSchema, ModelAliasSchema).default({}),
  /**
   * Codex utilization at or above which its quota counts as "low" (not in models.json; the spec
   * does not define the threshold). An exhausted quota is always low.
   */
  codex_low_utilization: z.number().min(0).max(1).default(0.8),
});
export type QuotaRules = z.infer<typeof QuotaRulesSchema>;

export const ModelRulesSchema = z.strictObject({
  max_fix_rounds_before_escalate: z.number().int().nonnegative(),
  reviewer_must_differ_from_implementer: z.boolean(),
  machine_checks_before_model_review: z.boolean(),
  quota: QuotaRulesSchema,
});
export type ModelRules = z.infer<typeof ModelRulesSchema>;

/**
 * Role of research runs (spec §17). Not required in models.json: without it the research
 * entrances refuse to create research tasks (validation error naming the role).
 */
export const RESEARCH_ROLE = 'oss_researcher';

/** Roles the engine needs: impl and review for every tier. */
export const REQUIRED_ROLES = ['impl_A', 'impl_B', 'impl_C', 'review_A', 'review_B', 'review_C'];

/** `config/models.json`: model roster, role assignment and rules. */
export const ModelsConfigSchema = z
  .strictObject({
    _readme: z.array(z.string()).optional(),
    updated: z.string().optional(),
    models: z.record(ModelAliasSchema, ModelEntrySchema),
    roles: z.record(RoleNameSchema, RoleEntrySchema),
    rules: ModelRulesSchema,
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const hasModel = (alias: string) => Object.hasOwn(cfg.models, alias);
    const hasRole = (role: string) => Object.hasOwn(cfg.roles, role);

    for (const role of REQUIRED_ROLES) {
      if (!hasRole(role)) issue(['roles', role], `required role "${role}" is missing`);
    }
    for (const [role, entry] of Object.entries(cfg.roles)) {
      if (!hasModel(entry.use)) issue(['roles', role, 'use'], `unknown model alias "${entry.use}"`);
      entry.fallback.forEach((alias, i) => {
        if (!hasModel(alias))
          issue(['roles', role, 'fallback', i], `unknown model alias "${alias}"`);
      });
      if (entry.escalate_to != null && !hasRole(entry.escalate_to)) {
        issue(['roles', role, 'escalate_to'], `unknown role "${entry.escalate_to}"`);
      }
      // escalation chains must terminate
      const seen = new Set<string>([role]);
      let next = entry.escalate_to ?? null;
      while (next != null && hasRole(next)) {
        if (seen.has(next)) {
          issue(['roles', role, 'escalate_to'], `escalation cycle through "${next}"`);
          break;
        }
        seen.add(next);
        next = cfg.roles[next]?.escalate_to ?? null;
      }
    }
    for (const mapName of ['when_claude_high', 'codex_low_quota'] as const) {
      for (const [role, alias] of Object.entries(cfg.rules.quota[mapName])) {
        if (!hasRole(role)) issue(['rules', 'quota', mapName, role], `unknown role "${role}"`);
        if (!hasModel(alias)) {
          issue(['rules', 'quota', mapName, role], `unknown model alias "${alias}"`);
        }
      }
    }
  });
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
/** What a hand-written models.json may omit (defaults filled by the schema). */
export type ModelsConfigInput = z.input<typeof ModelsConfigSchema>;

/** Parse and cross-check `config/models.json` content. Throws a ZodError on problems. */
export function parseModelsConfig(json: unknown): ModelsConfig {
  return ModelsConfigSchema.parse(json);
}
