import type { EffectKind, EffectRecord } from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import { addMs, backoffMs } from '../util/time.js';
import type { EngineContext } from './context.js';
import { openAttention } from './attention.js';
import { effectLane, effectPayload, type EffectHandler } from './effect-queue.js';
import { saveWorkspace } from './records.js';
import { runStartHandler } from './run-start.js';
import { verifyHandler } from './verify.js';

const runStop: EffectHandler = {
  async run(ctx, effect) {
    const { run_id: runId, reason } = effectPayload(effect, 'run.stop');
    // only runs started by this process can be aborted; others are already fenced off
    ctx.inflight.get(runId)?.abort(reason);
    return undefined;
  },
};

/**
 * `workspace.remove` (docs/adr/0009): an orphan (no workspace record) is removed with `force`;
 * a recorded workspace with uncommitted changes is never forced — it becomes `kept`, one attention
 * item asks a human, and the effect completes (no retry loop). Git errors throw and retry.
 */
const workspaceRemove: EffectHandler = {
  async run(ctx, effect) {
    const p = effectPayload(effect, 'workspace.remove');
    const res = await ctx.deps.git.removeWorktree({
      repoPath: p.repo_path,
      worktreePath: p.path,
      force: p.reason === 'orphan' && p.workspace_id === null,
    });
    if (!res.removed) {
      return (tx) => {
        const ws = p.workspace_id ? tx.r.workspaces.get(p.workspace_id) : undefined;
        tx.emit(
          'workspace.kept',
          { workspace_id: p.workspace_id, path: p.path, reason: res.reason, changes: res.changes },
          { task_id: ws?.task_id ?? null },
        );
        if (!ws || ws.state !== 'active') return;
        saveWorkspace(tx, ws, { state: 'kept' });
        openAttention(ctx, tx, {
          task_id: ws.task_id,
          kind: 'decision',
          question: `任務 ${ws.task_id} 的 worktree ${p.path} 有 ${res.changes} 個未提交的變更，已保留不刪除；請檢查後手動處理（保留或捨棄）。`,
          options: ['保留', '已手動處理'],
        });
      };
    }
    return (tx) => {
      const ws = p.workspace_id ? tx.r.workspaces.get(p.workspace_id) : undefined;
      if (ws && ws.state !== 'removed') {
        saveWorkspace(tx, ws, { state: 'removed', removed_at: tx.now });
      }
      tx.emit(
        'workspace.removed',
        { workspace_id: p.workspace_id, path: p.path, reason: p.reason },
        { task_id: ws?.task_id ?? null },
      );
    };
  },
};

const outboxSend: EffectHandler = {
  async run(ctx, effect) {
    const { outbox_id: id } = effectPayload(effect, 'outbox.send');
    const item = ctx.store.outbox.get(id);
    if (!item || item.status !== 'pending') return undefined;
    if (!ctx.deps.notifier) throw new Error('notifications are enabled but no Notifier is wired');
    await ctx.deps.notifier.send(item);
    return (tx) => {
      const current = tx.r.outbox.get(id);
      if (!current) return;
      tx.r.outbox.update({
        ...current,
        status: 'sent',
        attempts: effect.attempts + 1,
        error: null,
        sent_at: tx.now,
      });
      tx.emit('outbox.sent', { outbox_id: id }, { task_id: current.task_id });
    };
  },
  onDead(_ctx, tx, effect, error) {
    const { outbox_id: id } = effectPayload(effect, 'outbox.send');
    const current = tx.r.outbox.get(id);
    if (!current) return;
    tx.r.outbox.update({ ...current, status: 'failed', attempts: effect.attempts + 1, error });
    tx.emit('outbox.failed', { outbox_id: id, error }, { task_id: current.task_id });
  },
};

export const EFFECT_HANDLERS: Readonly<Record<EffectKind, EffectHandler>> = {
  'run.start': { run: runStartHandler },
  'run.stop': runStop,
  'run.verify': verifyHandler,
  'workspace.remove': workspaceRemove,
  'outbox.send': outboxSend,
};

const effectId = (e: EffectRecord) => `${e.kind}\u0000${e.key}`;

/**
 * Runs stored effects (spec §1.3): in seq order, one at a time per lane, concurrently across
 * lanes. Success deletes the row only if its generation is unchanged (a newer enqueue of the same
 * key survives); failure records attempts and a backoff `due`; after `effect_max_attempts` the
 * effect is dropped as dead (`effect.dead`) and the handler's `onDead` runs.
 */
export class EffectExecutor {
  private readonly running = new Set<string>();
  private readonly busyLanes = new Set<string>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly handlers: Readonly<Record<EffectKind, EffectHandler>> = EFFECT_HANDLERS,
  ) {}

  /** Start every due effect whose lane is free. Returns how many were started. */
  runDue(): number {
    const now = this.ctx.nowIso();
    const blocked = new Set(this.busyLanes);
    let started = 0;
    for (const effect of this.ctx.store.effects.list()) {
      const lane = effectLane(effect);
      if (this.running.has(effectId(effect))) {
        blocked.add(lane);
        continue;
      }
      if (blocked.has(lane)) continue;
      blocked.add(lane); // later effects in this lane wait, even if this one is not due yet
      if (effect.due > now) continue;
      this.start(effect, lane);
      started++;
    }
    return started;
  }

  /** Effects currently executing (for diagnostics). */
  get active(): number {
    return this.running.size;
  }

  private start(effect: EffectRecord, lane: string): void {
    const id = effectId(effect);
    this.running.add(id);
    this.busyLanes.add(lane);
    const done = this.execute(effect).finally(() => {
      this.running.delete(id);
      this.busyLanes.delete(lane);
    });
    this.ctx.track(done);
  }

  private async execute(effect: EffectRecord): Promise<void> {
    const handler = this.handlers[effect.kind];
    try {
      const finalize = await handler.run(this.ctx, effect);
      this.ctx.transact((tx) => {
        tx.r.effects.delete(effect.kind, effect.key, effect.generation);
        finalize?.(tx);
      });
    } catch (err) {
      this.fail(effect, handler, errorMessage(err));
    }
  }

  private fail(effect: EffectRecord, handler: EffectHandler, error: string): void {
    const { engine } = this.ctx.config;
    const attempts = effect.attempts + 1;
    this.ctx.logger.warn('effect failed', { kind: effect.kind, key: effect.key, attempts, error });
    this.ctx.transact((tx) => {
      if (attempts >= engine.effect_max_attempts) {
        if (!tx.r.effects.delete(effect.kind, effect.key, effect.generation)) return;
        tx.emit('effect.dead', { kind: effect.kind, key: effect.key, attempts, error });
        handler.onDead?.(this.ctx, tx, effect, error);
        return;
      }
      const due = addMs(
        tx.nowDate,
        backoffMs(attempts, engine.retry_initial_ms, engine.retry_max_ms),
      );
      const updated = tx.r.effects.recordFailure(effect.kind, effect.key, effect.generation, {
        attempts,
        due,
        error,
      });
      if (updated) {
        tx.emit('effect.failed', {
          kind: effect.kind,
          key: effect.key,
          attempts,
          error,
          next_due: due,
        });
      }
    });
  }
}
