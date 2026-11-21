import type { AnswerVia, Attention } from '@agent-team/schema';
import { ConflictError, NotFoundError } from '../errors.js';
import type { EngineContext, Tx } from './context.js';
import { notify } from './notify.js';

export interface OpenAttentionInput {
  task_id: string | null;
  kind: Attention['kind'];
  question: string;
  options: string[];
}

/** Open an attention item (server state) and notify; question/options are passed verbatim. */
export function openAttention(ctx: EngineContext, tx: Tx, input: OpenAttentionInput): Attention {
  const item: Attention = {
    id: ctx.newId('attention'),
    task_id: input.task_id,
    kind: input.kind,
    question: input.question,
    options: input.options,
    status: 'open',
    answer: null,
    answered_via: null,
    created_at: tx.now,
    answered_at: null,
  };
  tx.r.attention.insert(item);
  tx.emit(
    'attention.opened',
    { attention_id: item.id, kind: item.kind, question: item.question, options: item.options },
    { task_id: item.task_id },
  );
  notify(ctx, tx, {
    kind: 'attention',
    signature: `attention:${item.id}`,
    body: item.question,
    task_id: item.task_id,
  });
  return item;
}

/**
 * Record an answer. Only open items can be answered; the engine does not act on the answer
 * itself — the leader or a human follows up with task actions.
 */
export function answerAttention(tx: Tx, id: string, answer: string, via: AnswerVia): Attention {
  const item = tx.r.attention.get(id);
  if (!item) throw new NotFoundError('attention', id);
  if (item.status !== 'open') throw new ConflictError(`attention ${id} is ${item.status}`);
  const next: Attention = {
    ...item,
    status: 'answered',
    answer,
    answered_via: via,
    answered_at: tx.now,
  };
  tx.r.attention.update(next);
  tx.emit('attention.answered', { attention_id: id, answer, via }, { task_id: item.task_id });
  return next;
}
