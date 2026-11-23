import type { EventRecord } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { isLeaderRelevant } from './digest.js';
import { CANCELLED_RULE, leaderPromptVersion, leaderSystemPrompt } from './prompt/system-v7.js';

// Prompt v7 (spec §9): 2026-11-23 the leader re-added two tasks a human had just cancelled, twice
// in a row. A cancellation it did not make in this turn is the person's decision and final.

const MODES = ['off', 'on_request', 'auto'] as const;

describe('v7 the leader never undoes a cancellation', () => {
  it('carries the rule in every research and memory mode, under a new prompt version', () => {
    for (const mode of MODES) {
      for (const memory of [false, true]) {
        const prompt = leaderSystemPrompt(mode, memory);
        expect(prompt).toContain(CANCELLED_RULE);
        expect(prompt).not.toContain('{{');
        // the digest instruction no longer treats a cancellation as "needs action"
        expect(prompt).toContain('任務被取消不算需要動作');
        expect(leaderPromptVersion(mode, memory)).toBe(`v7-${mode}${memory ? '-memory' : ''}`);
      }
    }
    for (const s of [
      '`cancelled`',
      '不要重新建立、重新加入或排入',
      '最多一句回報',
      '使用者在訊息裡要求',
    ]) {
      expect(CANCELLED_RULE).toContain(s);
    }
  });

  it('a cancellation never becomes a digest line (events carry no actor to label)', () => {
    const event = {
      seq: 1,
      ts: '2026-11-23T00:00:00.000Z',
      task_id: 't1',
      run_id: null,
      type: 'task.status_changed',
      data: { from: 'running', to: 'cancelled', reason: 'cancelled' },
    } as EventRecord;
    expect(isLeaderRelevant(event)).toBe(false);
  });
});
