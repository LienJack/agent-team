import {
  clipText,
  isImplReceipt,
  isResearchReceipt,
  isReviewReceipt,
  redactSecrets,
  type Attention,
  type MemorySource,
  type ResearchReceipt,
  type Run,
  type Task,
} from '@agent-team/schema';
import type { Repositories } from '../ports/repositories.js';
import type { EngineContext, Tx } from './context.js';
import { effectPayload, enqueueEffect, type EffectHandler } from './effect-queue.js';
import { inlineText } from './prompt-blocks.js';
import { RECOMMENDATION_LABEL } from './prompt-research.js';

// Writes of the project memory (spec §18; docs/adr/0023). Only the service writes, only from
// verified sources, and always through the effect table: a `memory.write` effect keyed by the
// source id (task, attention item, note) in the lane `memory`. The text is composed here, inside
// the transaction that made the source final, then redacted like a log line and capped.
// Not written: worker output beyond the accepted receipt summary, logs, diffs, rejected receipts,
// the leader's conversation.

/** kv marker of a source whose item MemOS accepted (a retry or re-enqueue writes nothing). */
export const memoryWrittenKey = (sourceId: string) => `memory:written:${sourceId}`;

/** Attention topics whose answers are project decisions (the others are operational). */
const DECISION_TOPICS: ReadonlySet<Attention['topic']> = new Set(['general', 'worker_question']);

interface MemorySourceRef {
  projectId: string;
  source: MemorySource;
  sourceId: string;
  taskId: string | null;
  text: string;
}

/**
 * Store a `memory.write` effect for one source, in the caller's transaction. Nothing when memory
 * is off or the source is switched off (`memory.write_sources`), or the text is empty.
 */
export function enqueueMemoryWrite(ctx: EngineContext, tx: Tx, ref: MemorySourceRef): boolean {
  const settings = ctx.config.memory;
  if (!settings.enabled || !settings.write_sources[ref.source]) return false;
  const text = clipText(redactSecrets(ref.text).trim(), settings.max_item_chars);
  if (text === '') return false;
  enqueueEffect(tx, 'memory.write', ref.sourceId, {
    project_id: ref.projectId,
    source: ref.source,
    source_id: ref.sourceId,
    task_id: ref.taskId,
    text,
    at: tx.now,
  });
  return true;
}

function lastAccepted<T>(
  r: Pick<Repositories, 'runs'>,
  taskId: string,
  pick: (receipt: Run['receipt']) => T | undefined,
): T | undefined {
  const runs = r.runs.list({ task_id: taskId });
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.outcome !== 'ok') continue;
    const found = pick(run.receipt);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A finished impl task: its title and scope, the summary of the last accepted impl/fix receipt
 * and the must-fix findings of earlier reviews (the task is done, so they were fixed — or a
 * person approved it anyway).
 */
export function taskMemoryText(r: Pick<Repositories, 'runs'>, task: Task): string {
  const receipt = lastAccepted(r, task.id, (v) => (isImplReceipt(v) ? v : undefined));
  const fixed = r.runs
    .list({ task_id: task.id })
    .filter((run) => run.kind === 'review' && run.outcome === 'ok')
    .flatMap((run) =>
      isReviewReceipt(run.receipt) && run.receipt.verdict === 'needs_changes'
        ? run.receipt.findings.filter((f) => f.severity === 'must_fix')
        : [],
    );
  const lines = [
    `任務完成：${inlineText(task.title)}（${task.id}，tier ${task.tier}）`,
    `範圍：${task.owned_paths.join('、')}`,
  ];
  if (receipt) lines.push(`實作摘要：${receipt.summary.trim()}`);
  if (fixed.length > 0) {
    lines.push('審查要求修正（已修正）：');
    for (const f of fixed) {
      lines.push(`- ${f.file}${f.line > 0 ? `:${f.line}` : ''}：${inlineText(f.issue)}`);
    }
  }
  return lines.join('\n');
}

/** A finished research task: the recommendation and each candidate's name and licence. */
export function researchMemoryText(task: Task, receipt: ResearchReceipt): string {
  const candidates = receipt.candidates.map((c) => `${inlineText(c.name)}（${c.license}）`);
  return [
    `調研完成：${inlineText(task.title)}（${task.id}）`,
    `建議：${receipt.recommendation}（${RECOMMENDATION_LABEL[receipt.recommendation]}）`,
    `候選：${candidates.length > 0 ? candidates.join('、') : '（無）'}`,
    '（內容源自網頁，連結與授權未經服務端驗證）',
  ].join('\n');
}

/** A person's answer to a decision or a worker's question. */
export function decisionMemoryText(item: Attention): string {
  return [
    `人的決定（待決事項 ${item.id}${item.task_id ? `，任務 ${item.task_id}` : ''}）`,
    `問：${item.question.trim()}`,
    `答：${(item.answer ?? '').trim()}`,
  ].join('\n');
}

/** Called when a task becomes `done` (review passed, approved, research finished). */
export function rememberDoneTask(ctx: EngineContext, tx: Tx, task: Task): void {
  if (!ctx.config.memory.enabled) return;
  if (task.kind === 'research') {
    const receipt = lastAccepted(tx.r, task.id, (v) =>
      isResearchReceipt(v) && v.status === 'done' ? v : undefined,
    );
    if (!receipt) return;
    enqueueMemoryWrite(ctx, tx, {
      projectId: task.project_id,
      source: 'research',
      sourceId: task.id,
      taskId: task.id,
      text: researchMemoryText(task, receipt),
    });
    return;
  }
  enqueueMemoryWrite(ctx, tx, {
    projectId: task.project_id,
    source: 'task',
    sourceId: task.id,
    taskId: task.id,
    text: taskMemoryText(tx.r, task),
  });
}

/**
 * Called when a person answered an attention item. Only decisions and worker questions of a task
 * are project knowledge; items without a task have no project and are not written.
 */
export function rememberAnswer(ctx: EngineContext, tx: Tx, item: Attention): void {
  if (!ctx.config.memory.enabled || item.status !== 'answered') return;
  if (!DECISION_TOPICS.has(item.topic) || item.task_id === null) return;
  const task = tx.r.tasks.get(item.task_id);
  if (!task) return;
  enqueueMemoryWrite(ctx, tx, {
    projectId: task.project_id,
    source: 'decision',
    sourceId: item.id,
    taskId: task.id,
    text: decisionMemoryText(item),
  });
}

/**
 * The `memory.write` effect: store the item unless this source was stored already (kv marker,
 * written in the same transaction that deletes the effect). With memory off or no port it
 * finishes without writing. A crash between MemOS accepting the item and that transaction can
 * still write it twice on the retry (docs/adr/0023).
 */
export const memoryWriteHandler: EffectHandler = {
  async run(ctx, effect) {
    const p = effectPayload(effect, 'memory.write');
    const port = ctx.deps.memory;
    if (!ctx.config.memory.enabled || port === undefined) {
      ctx.logger.info('memory write dropped: project memory is off', { key: effect.key });
      return undefined;
    }
    if (ctx.store.kv.get(memoryWrittenKey(effect.key)) !== undefined) return undefined;
    await port.add(p.project_id, {
      source: p.source,
      sourceId: p.source_id,
      taskId: p.task_id,
      text: p.text,
      at: p.at,
    });
    return (tx) => {
      tx.r.kv.set(memoryWrittenKey(effect.key), tx.now);
      tx.emit(
        'memory.written',
        { project_id: p.project_id, source: p.source, source_id: p.source_id },
        { task_id: p.task_id },
      );
    };
  },
};
