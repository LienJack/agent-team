import type {
  Effort,
  ModelsConfig,
  RunnerHealth,
  RunnerName,
  RunnerStatus,
} from '@agent-team/schema';
import { RunnerNameSchema } from '@agent-team/schema';
import { isAfter } from '../util/time.js';
import { exhaustedUntil } from './quota-wait.js';

/** Per-runner health/availability as seen by `resolveRole` (keyed by runner name). */
export type QuotaState = Readonly<
  Partial<Record<string, Pick<RunnerStatus, 'available'> & RunnerHealth>>
>;

export interface ResolveRoleOptions {
  models: ModelsConfig;
  now: Date;
  /** Aliases that must not be chosen (reviewer ≠ implementer). */
  excludeAliases?: readonly string[];
  /**
   * Runners whose half-open circuit already has its one trial run in flight (L9e): skipped
   * until the trial closes or re-opens the circuit.
   */
  trialBusy?: ReadonlySet<string>;
  /**
   * Research runs (spec §17): only aliases whose runner can run web-only runs qualify
   * (`supports.webSearch` of its last probe; unknown = no). Without this option every runner
   * qualifies.
   */
  webSearch?: (runner: RunnerName) => boolean;
}

/** Whether a runner's circuit is half-open (opened once, the open window has passed). */
export function isHalfOpen(health: RunnerHealth | undefined, now: Date): boolean {
  return (
    health !== undefined &&
    health.circuit_open_until !== null &&
    !isAfter(health.circuit_open_until, now)
  );
}

export interface ResolvedModel {
  ok: true;
  role: string;
  alias: string;
  runner: RunnerName;
  model: string;
  effort?: Effort;
  /** Where the alias came from. */
  via: 'use' | 'fallback' | 'when_claude_high' | 'codex_low_quota';
  skipped: Array<{ alias: string; reason: string }>;
}

export interface UnresolvedModel {
  ok: false;
  role: string;
  /**
   * `no_candidate`: every alias is cooling down/unavailable right now (retry later);
   * `no_web_search`: no alias of the role can run research runs at all (spec §17).
   */
  reason: 'unknown_role' | 'role_disabled' | 'no_candidate' | 'no_web_search';
  /** Earliest time a skipped candidate becomes available again, if known. */
  retryAt: string | null;
  skipped: Array<{ alias: string; reason: string }>;
}

export type ResolveRoleResult = ResolvedModel | UnresolvedModel;

function utilization(state: QuotaState, runner: string): { util: number; exhausted: boolean } {
  const q = state[runner]?.quota;
  return { util: q?.utilization ?? 0, exhausted: q?.exhausted ?? false };
}

function blockedUntil(
  health: (Pick<RunnerStatus, 'available'> & RunnerHealth) | undefined,
  now: Date,
  trialBusy: ReadonlySet<string>,
): { reason: string; until: string | null } | undefined {
  if (!health) return { reason: 'not_registered', until: null };
  // stopped by the rate-limit loop guard until a person re-arms it (docs/adr/0022)
  if (health.halted_at) return { reason: 'rate_limit_loop', until: null };
  if (isHalfOpen(health, now) && trialBusy.has(health.runner)) {
    return { reason: 'circuit_trial_in_flight', until: null };
  }
  if (isAfter(health.cooldown_until, now))
    return { reason: 'cooldown', until: health.cooldown_until };
  if (isAfter(health.circuit_open_until, now)) {
    return { reason: 'circuit_open', until: health.circuit_open_until };
  }
  const quotaUntil = exhaustedUntil(health);
  if (quotaUntil !== undefined && isAfter(quotaUntil, now)) {
    return { reason: 'quota_exhausted', until: quotaUntil };
  }
  if (!health.available) return { reason: 'unavailable', until: null };
  return undefined;
}

/**
 * Pick the model for `role` (spec §8): the primary alias, then fallbacks in order, skipping
 * runners that are cooling down, circuit-open, out of quota or unavailable, and aliases in
 * `excludeAliases`. `rules.quota` puts a preferred alias first while Claude utilization is high
 * (`when_claude_high`) or Codex quota is low (`codex_low_quota`, applied last so it wins).
 */
export function resolveRole(
  role: string,
  quotaState: QuotaState,
  options: ResolveRoleOptions,
): ResolveRoleResult {
  const { models, now } = options;
  const entry = models.roles[role];
  const skipped: Array<{ alias: string; reason: string }> = [];
  if (!entry) return { ok: false, role, reason: 'unknown_role', retryAt: null, skipped };
  if (!entry.enabled) return { ok: false, role, reason: 'role_disabled', retryAt: null, skipped };

  type Via = ResolvedModel['via'];
  let candidates: Array<{ alias: string; via: Via }> = [
    { alias: entry.use, via: 'use' },
    ...entry.fallback.map((alias) => ({ alias, via: 'fallback' as Via })),
  ];
  const prefer = (alias: string | undefined, via: Via) => {
    if (alias === undefined) return;
    candidates = [{ alias, via }, ...candidates.filter((c) => c.alias !== alias)];
  };
  const quotaRules = models.rules.quota;
  const claude = utilization(quotaState, 'claude');
  if (claude.exhausted || claude.util >= quotaRules.claude_high_utilization) {
    prefer(quotaRules.when_claude_high[role], 'when_claude_high');
  }
  const codex = utilization(quotaState, 'codex');
  if (codex.exhausted || codex.util >= quotaRules.codex_low_utilization) {
    prefer(quotaRules.codex_low_quota[role], 'codex_low_quota');
  }

  const exclude = new Set(options.excludeAliases ?? []);
  let retryAt: string | null = null;
  let webCapable = 0;
  for (const { alias, via } of candidates) {
    const model = models.models[alias];
    if (!model) {
      skipped.push({ alias, reason: 'unknown_alias' });
      continue;
    }
    if (exclude.has(alias)) {
      skipped.push({ alias, reason: 'excluded' });
      continue;
    }
    const runner = RunnerNameSchema.safeParse(model.runner);
    if (!runner.success) {
      skipped.push({ alias, reason: 'not_a_text_runner' });
      continue;
    }
    if (options.webSearch && !options.webSearch(runner.data)) {
      skipped.push({ alias, reason: 'no_web_search' });
      continue;
    }
    webCapable++;
    const blocked = blockedUntil(quotaState[runner.data], now, options.trialBusy ?? new Set());
    if (blocked) {
      skipped.push({ alias, reason: blocked.reason });
      if (blocked.until && (retryAt === null || blocked.until < retryAt)) retryAt = blocked.until;
      continue;
    }
    const resolved: ResolvedModel = {
      ok: true,
      role,
      alias,
      runner: runner.data,
      model: model.model,
      via,
      skipped,
    };
    if (model.effort !== undefined) resolved.effort = model.effort;
    return resolved;
  }
  // research: nothing to wait for when no alias of the role has a web-capable runner
  const reason = options.webSearch && webCapable === 0 ? 'no_web_search' : 'no_candidate';
  return { ok: false, role, reason, retryAt, skipped };
}
