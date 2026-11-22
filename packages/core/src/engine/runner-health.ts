import {
  RunnerHealthSchema,
  runnerHealthKey,
  type CircuitState,
  type RunnerHealth,
  type RunnerName,
  type Run,
  type RunnerStatus,
  type RunQuota,
} from '@agent-team/schema';
import type { KvRepository } from '../ports/repositories.js';
import type { RunnerRegistry } from '../ports/runner.js';
import { addMs, isAfter } from '../util/time.js';
import { openAttention } from './attention.js';
import type { EngineContext, Tx } from './context.js';
import { notify } from './notify.js';
import { exhaustedUntil, quotaWaitUntil } from './quota-wait.js';

// Cooldown, circuit breaker and quota per runner (spec §8), persisted in kv as JSON. Plus the
// rate-limit loop guard (docs/adr/0022): a runner whose first run after each of
// `rate_limit_loop_limit` cooldowns in a row hit the rate limit again stops resuming by itself.

export function defaultHealth(runner: RunnerName): RunnerHealth {
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
  // stopped by the loop guard: open until a person re-arms it
  if (health.halted_at !== null) return 'open';
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
  if (health.halted_at !== null) return { reason: 'rate_limit_loop', until: null };
  if (isAfter(health.cooldown_until, now)) {
    return { reason: 'cooldown', until: health.cooldown_until };
  }
  if (isAfter(health.circuit_open_until, now)) {
    return { reason: 'circuit_open', until: health.circuit_open_until };
  }
  const quotaUntil = exhaustedUntil(health);
  if (quotaUntil !== undefined && isAfter(quotaUntil, now)) {
    return { reason: 'quota_exhausted', until: quotaUntil };
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

/**
 * Rate limit: cool the runner down until `resetsAt` + buffer + jitter, or the configured default
 * (15 min) when the reset is unknown, in the past or more than 8 days ahead. The loop guard
 * counts cooldown windows, not failed runs: only a run that started after the last cooldown had
 * ended counts (runs already in flight when the window began return `rate_limit` too and do not).
 * At `rate_limit_loop_limit` the runner is halted (see `haltRunner`).
 */
export function startCooldown(
  ctx: EngineContext,
  tx: Tx,
  run: Pick<Run, 'runner' | 'started_at'>,
  resetsAt: string | undefined,
  reason: string,
): string {
  const runner = run.runner;
  const health = readHealth(tx.r.kv, runner);
  const until =
    quotaWaitUntil(resetsAt, tx.nowDate, runner) ??
    addMs(tx.nowDate, ctx.config.engine.rate_limit_cooldown_ms);
  // the first run started after the last cooldown hit the limit again
  const afterCooldown =
    health.probe_after_cooldown &&
    health.cooldown_until !== null &&
    run.started_at >= health.cooldown_until;
  const loops = health.rate_limit_loops + (afterCooldown ? 1 : 0);
  writeHealth(tx.r.kv, {
    ...health,
    cooldown_until: until,
    cooldown_reason: reason,
    rate_limit_loops: loops,
    probe_after_cooldown: true,
  });
  tx.emit('runner.cooldown', { runner, until, reason });
  if (afterCooldown && loops >= ctx.config.engine.rate_limit_loop_limit) {
    haltRunner(ctx, tx, runner, loops);
  }
  return until;
}

/** Loop guard tripped: no more automatic resumption; one attention item explains it. */
function haltRunner(ctx: EngineContext, tx: Tx, runner: RunnerName, loops: number): void {
  const health = readHealth(tx.r.kv, runner);
  if (health.halted_at !== null) return;
  const item = openAttention(ctx, tx, {
    task_id: null,
    kind: 'decision',
    topic: 'runner_halted',
    question: `runner ${runner} 連續 ${loops} 次在額度冷卻結束後的第一個 run 又撞到額度上限，已停止自動恢復（熔斷開啟）；使用它的角色改用 fallback 的模型，沒有 fallback 的任務會等待。確認額度已恢復後回答「重新啟用」（人重試使用它的任務也會重新啟用）。`,
    options: ['重新啟用'],
  });
  writeHealth(tx.r.kv, { ...health, halted_at: tx.now, halted_attention_id: item.id });
  tx.emit('runner.halted', { runner, loops, attention_id: item.id });
}

/**
 * A person re-armed a halted runner (answered its item, or retried a task that uses it): the
 * loop count starts over and the circuit closes. An item still open is superseded. No-op for a
 * runner that is not halted. Returns whether it was halted.
 */
export function rearmRunner(tx: Tx, runner: RunnerName): boolean {
  const health = readHealth(tx.r.kv, runner);
  if (health.halted_at === null) return false;
  const itemId = health.halted_attention_id;
  writeHealth(tx.r.kv, {
    ...health,
    rate_limit_loops: 0,
    probe_after_cooldown: false,
    halted_at: null,
    halted_attention_id: null,
  });
  const item = itemId === null ? undefined : tx.r.attention.get(itemId);
  if (item?.status === 'open') {
    tx.r.attention.update({ ...item, status: 'superseded' });
    tx.emit('attention.superseded', { attention_id: item.id }, { task_id: null });
  }
  tx.emit('runner.circuit_closed', { runner });
  return true;
}

/** The runner halted by the loop guard whose item `attentionId` is, if any. */
export function haltedRunnerOf(
  kv: KvRepository,
  registry: RunnerRegistry,
  attentionId: string,
): RunnerName | undefined {
  return registry.names().find((r) => readHealth(kv, r).halted_attention_id === attentionId);
}

/** A run of this runner finished without a runner error: close the circuit. */
export function recordRunnerSuccess(tx: Tx, runner: RunnerName): void {
  const health = readHealth(tx.r.kv, runner);
  const clean =
    health.consecutive_failures === 0 &&
    health.circuit_open_until === null &&
    health.rate_limit_loops === 0 &&
    !health.probe_after_cooldown;
  if (clean) return;
  // a success also ends a rate-limit loop (a halted runner stays halted until a person re-arms)
  writeHealth(tx.r.kv, {
    ...health,
    consecutive_failures: 0,
    circuit_open_until: null,
    rate_limit_loops: 0,
    probe_after_cooldown: false,
  });
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
