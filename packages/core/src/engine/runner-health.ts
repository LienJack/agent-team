import {
  RunnerHealthSchema,
  runnerHealthKey,
  type CircuitState,
  type RunnerHealth,
  type RunnerName,
  type RunnerStatus,
  type RunQuota,
} from '@agent-team/schema';
import type { KvRepository } from '../ports/repositories.js';
import type { RunnerRegistry } from '../ports/runner.js';
import { addMs, isAfter } from '../util/time.js';
import type { EngineContext, Tx } from './context.js';
import { notify } from './notify.js';

// Cooldown, circuit breaker and quota per runner (spec §8), persisted in kv as JSON.

export function defaultHealth(runner: RunnerName): RunnerHealth {
  return {
    runner,
    cooldown_until: null,
    cooldown_reason: null,
    consecutive_failures: 0,
    circuit_open_until: null,
    quota: null,
  };
}

export function readHealth(kv: KvRepository, runner: RunnerName): RunnerHealth {
  const raw = kv.get(runnerHealthKey(runner));
  if (raw === undefined) return defaultHealth(runner);
  const parsed = RunnerHealthSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : defaultHealth(runner);
}

function writeHealth(kv: KvRepository, health: RunnerHealth): void {
  kv.set(runnerHealthKey(health.runner), JSON.stringify(health));
}

export function circuitState(health: RunnerHealth, now: Date): CircuitState {
  if (health.circuit_open_until === null) return 'closed';
  return isAfter(health.circuit_open_until, now) ? 'open' : 'half_open';
}

/** Why a runner cannot take work right now, and until when (if known). */
export function unavailability(
  health: RunnerHealth,
  now: Date,
  registry?: RunnerRegistry,
): { reason: string; until: string | null } | undefined {
  if (registry && !registry.get(health.runner)) return { reason: 'not_registered', until: null };
  if (registry?.capabilities(health.runner)?.available === false) {
    return { reason: 'unavailable', until: null };
  }
  if (isAfter(health.cooldown_until, now)) {
    return { reason: 'cooldown', until: health.cooldown_until };
  }
  if (isAfter(health.circuit_open_until, now)) {
    return { reason: 'circuit_open', until: health.circuit_open_until };
  }
  if (health.quota?.exhausted && isAfter(health.quota.resets_at, now)) {
    return { reason: 'quota_exhausted', until: health.quota.resets_at };
  }
  return undefined;
}

export function runnerStatuses(
  kv: KvRepository,
  registry: RunnerRegistry,
  now: Date,
): RunnerStatus[] {
  return registry.names().map((name) => {
    const health = readHealth(kv, name);
    return {
      ...health,
      available: unavailability(health, now, registry) === undefined,
      circuit: circuitState(health, now),
    };
  });
}

/** Store quota reported by a run; notifies once per exhaustion window. */
export function recordQuota(ctx: EngineContext, tx: Tx, runner: RunnerName, quota: RunQuota): void {
  const health = readHealth(tx.r.kv, runner);
  const next: RunnerHealth = {
    ...health,
    quota: {
      utilization: quota.utilization ?? health.quota?.utilization ?? null,
      resets_at: quota.resetsAt ?? health.quota?.resets_at ?? null,
      exhausted: quota.exhausted ?? false,
      updated_at: tx.now,
    },
  };
  writeHealth(tx.r.kv, next);
  const q = next.quota!;
  tx.emit('runner.quota', {
    runner,
    utilization: q.utilization,
    resets_at: q.resets_at,
    exhausted: q.exhausted,
  });
  if (q.exhausted && !health.quota?.exhausted) {
    notify(ctx, tx, {
      kind: 'quota_exhausted',
      signature: `quota_exhausted:${runner}:${q.resets_at ?? tx.now}`,
      body: `額度用完：${runner}${q.resets_at ? `，預計 ${q.resets_at} 重置` : ''}`,
      task_id: null,
    });
  }
}

/** Rate limit: cool the runner down until `resetsAt`, or the configured default (15 min). */
export function startCooldown(
  ctx: EngineContext,
  tx: Tx,
  runner: RunnerName,
  resetsAt: string | undefined,
  reason: string,
): string {
  const health = readHealth(tx.r.kv, runner);
  const fallback = addMs(tx.nowDate, ctx.config.engine.rate_limit_cooldown_ms);
  const until = resetsAt && isAfter(resetsAt, tx.nowDate) ? resetsAt : fallback;
  writeHealth(tx.r.kv, { ...health, cooldown_until: until, cooldown_reason: reason });
  tx.emit('runner.cooldown', { runner, until, reason });
  return until;
}

/** A run of this runner finished without a runner error: close the circuit. */
export function recordRunnerSuccess(tx: Tx, runner: RunnerName): void {
  const health = readHealth(tx.r.kv, runner);
  if (health.consecutive_failures === 0 && health.circuit_open_until === null) return;
  writeHealth(tx.r.kv, { ...health, consecutive_failures: 0, circuit_open_until: null });
  if (health.circuit_open_until !== null) tx.emit('runner.circuit_closed', { runner });
}

/**
 * A run failed for a runner reason (not rate limit, not cancellation). After
 * `circuit_failure_threshold` consecutive failures the circuit opens for `circuit_open_ms`;
 * a failed trial while half-open re-opens it immediately.
 */
export function recordRunnerFailure(ctx: EngineContext, tx: Tx, runner: RunnerName): void {
  const health = readHealth(tx.r.kv, runner);
  const failures = health.consecutive_failures + 1;
  const threshold = ctx.config.engine.circuit_failure_threshold;
  let next: RunnerHealth = { ...health, consecutive_failures: failures };
  if (failures >= threshold) {
    const until = addMs(tx.nowDate, ctx.config.engine.circuit_open_ms);
    next = { ...next, circuit_open_until: until };
    tx.emit('runner.circuit_opened', { runner, failures, until });
    notify(ctx, tx, {
      kind: 'circuit_open',
      signature: `circuit_open:${runner}:${tx.now}`,
      body: `runner 熔斷：${runner} 連續失敗 ${failures} 次，暫停到 ${until}`,
      task_id: null,
    });
  }
  writeHealth(tx.r.kv, next);
}
