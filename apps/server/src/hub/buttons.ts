import { isHighRiskAttention, type Attention, type ServiceConfig } from '@agent-team/schema';

// When a Grok message about an attention item carries option buttons, and when a Grok answer is
// accepted (spec §10, docs/adr/0022 §3). One verdict for both, taken at the moment of sending
// and again at the moment of answering:
// - exactly one attention item is open in total (otherwise a pick could land on the wrong one);
// - the item is not high risk (`ATTENTION_TOPIC_RISK`: discarding work, bypassing a safety stop
//   — those are answered from the board or the CLI only);
// - it has options, and the full question and every option fit the limits whole (no buttons on
//   a truncated question).
// Otherwise the message is plain text pointing to the board or the CLI, and a Grok answer gets a
// reply saying why it was not recorded.

export type ButtonLimits = ServiceConfig['grok']['buttons'];

export type NoButtons = 'not_open' | 'high_risk' | 'several_open' | 'no_options' | 'too_long';

export type ButtonVerdict = { ok: true } | { ok: false; why: NoButtons };

export function buttonVerdict(
  item: Attention,
  open: readonly Attention[],
  limits: ButtonLimits,
): ButtonVerdict {
  if (item.status !== 'open') return { ok: false, why: 'not_open' };
  if (isHighRiskAttention(item)) return { ok: false, why: 'high_risk' };
  if (open.length !== 1 || open[0]!.id !== item.id) return { ok: false, why: 'several_open' };
  if (item.options.length === 0) return { ok: false, why: 'no_options' };
  const fits =
    item.question.length <= limits.question_max_chars &&
    item.question.length <= limits.message_max_chars &&
    item.options.length <= limits.max_options &&
    item.options.every((o) => o.length <= limits.option_max_chars);
  return fits ? { ok: true } : { ok: false, why: 'too_long' };
}

/** The CLI command that answers `item`. */
export function answerCommand(item: Attention): string {
  return `team attention answer ${item.id} "<${item.options.length > 0 ? '選項' : '回答'}>"`;
}

/** The message about an item that gets no buttons: question and options verbatim + where to answer. */
export function boardNotice(item: Attention, why: NoButtons, openCount: number): string {
  const lines = [`需要你決定：${item.question}`];
  if (item.options.length > 0) lines.push('選項：', ...item.options.map((o) => `- ${o}`));
  if (why === 'high_risk') {
    lines.push(
      '這個決定可能捨棄工作或略過安全檢查，只能在看板或 CLI 回答（Grok 的回覆不會被記錄）：',
    );
  } else if (why === 'several_open') {
    lines.push(`目前有 ${openCount} 個待決事項，請在看板或 CLI 回答：`);
  } else {
    lines.push('請在看板或 CLI 回答：');
  }
  lines.push(answerCommand(item));
  return lines.join('\n');
}

/** The reply to a Grok answer that was not recorded, saying why. */
export function refusalText(item: Attention, why: NoButtons, openCount: number): string {
  switch (why) {
    case 'not_open':
      return `這個問題已經處理過了（${item.id} 是 ${item.status}），沒有記錄這次的選擇。`;
    case 'high_risk':
      return `沒有記錄這次的選擇：這個決定可能捨棄工作或略過安全檢查，只能在看板或 CLI 回答（${answerCommand(item)}）。`;
    case 'several_open':
      return `沒有記錄這次的選擇：目前有 ${openCount} 個待決事項，無法確定它對應哪一個；請在看板或 CLI 回答（team attention list）。`;
    default:
      return `沒有記錄這次的選擇：這個問題請在看板或 CLI 回答（${answerCommand(item)}）。`;
  }
}
