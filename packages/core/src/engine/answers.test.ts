import type { RunSpec } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { implReceipt, reviewReceipt } from '../testing/fake-runner.js';
import { createTestEngine, type TestEngine } from '../testing/harness.js';

// Answers to a worker's question (2026-11-21 validation with real workers, project s4): the
// review asked for a file outside owned_paths, the fix worker reported `blocked` with a question,
// the person answered "not needed" — and the answer never reached the next worker, which asked
// again; a fix run that rightly changed nothing was rejected `no_changes`.

const QUESTION = 'README.md 不在 owned_paths，要不要更新範例？';
const ANSWER = 'README 不在這個任務的範圍，不用改；src/feature 正確即可。';
const FIX_HEADER = '## 修正要求';

/** impl edits; reviews want README until the answer is in their prompt; fix runs ask until then. */
function script(h: TestEngine): RunSpec[] {
  const specs: RunSpec[] = [];
  for (const r of Object.values(h.runners)) {
    r.defaultStep = {
      onRun: (spec) => {
        specs.push(spec);
        if (spec.writable && !spec.prompt.includes(FIX_HEADER)) {
          h.git.touch(spec.cwd, ['src/feature/a.ts']);
        }
      },
      result: (spec) => {
        const answered = spec.prompt.includes(ANSWER);
        if (!spec.writable) {
          return answered
            ? { final: reviewReceipt(spec) }
            : {
                final: reviewReceipt(spec, {
                  verdict: 'needs_changes',
                  summary: 'README 範例沒有更新',
                  findings: [
                    { file: 'README.md', line: 6, severity: 'must_fix', issue: '更新範例' },
                  ],
                }),
              };
        }
        if (spec.prompt.includes(FIX_HEADER) && !answered) {
          return {
            final: implReceipt(spec, {
              status: 'blocked',
              summary: '需要決定',
              needs_leader: QUESTION,
            }),
          };
        }
        return { final: implReceipt(spec) };
      },
    };
  }
  return specs;
}

describe('answers to attention items reach the next worker', () => {
  it('answering the last open question requeues the task; the answer is in the prompts; a fix that changes nothing goes back to review', async () => {
    const h = createTestEngine();
    const task = h.task();
    const specs = script(h);
    await h.engine.runUntilIdle();

    expect(h.get(task.id)).toMatchObject({ status: 'blocked', fix_rounds: 1 });
    const [item] = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
    expect(item).toMatchObject({ kind: 'question', question: QUESTION });
    const headBefore = h.store.workspaces.findCurrentByTask(task.id)!.head_sha;
    expect(headBefore).not.toBeNull();

    h.engine.answerAttention(item!.id, ANSWER, 'cli');
    expect(h.get(task.id)).toMatchObject({ status: 'queued', blocked_reason: null, attempts: 0 });
    await h.engine.runUntilIdle();

    expect(h.get(task.id)).toMatchObject({ status: 'done', fix_rounds: 1 });
    const runs = h.store.runs.list({ task_id: task.id });
    expect(runs.map((r) => `${r.kind}:${r.outcome}`)).toEqual([
      'impl:ok',
      'review:ok',
      'fix:ok', // blocked with the question
      'fix:ok', // no new changes: the committed head is checked again and reviewed
      'review:ok',
    ]);
    const [, , blockedFix, quietFix, lastReview] = specs;
    expect(blockedFix!.prompt).not.toContain('## 人的回答');
    for (const spec of [quietFix!, lastReview!]) {
      expect(spec.prompt).toContain('## 人的回答（先前的待決事項）');
      expect(spec.prompt).toContain(QUESTION);
      expect(spec.prompt).toContain(ANSWER);
    }
    // nothing new was committed for the quiet fix run
    expect(h.store.workspaces.findCurrentByTask(task.id)!.head_sha).toBe(headBefore);
  });

  it('waits until every open item of the task is answered', async () => {
    const h = createTestEngine();
    const task = h.task();
    script(h);
    await h.engine.runUntilIdle();
    const extra = h.engine.openAttention({
      task_id: task.id,
      kind: 'decision',
      question: '要不要另開一張 README 的任務？',
      options: ['要', '不要'],
    });
    const question = h.store.attention
      .list({ task_id: task.id, statuses: ['open'] })
      .find((a) => a.id !== extra.id);
    h.engine.answerAttention(question!.id, ANSWER, 'web');
    expect(h.get(task.id).status).toBe('blocked');
    h.engine.answerAttention(extra.id, '不要', 'web');
    expect(h.get(task.id).status).toBe('queued');
  });

  it('does not requeue a task blocked for another reason (a reviewer that could not review)', async () => {
    const h = createTestEngine();
    const task = h.task();
    for (const r of Object.values(h.runners)) {
      r.defaultStep = {
        onRun: (spec) => {
          if (spec.writable) h.git.touch(spec.cwd, ['src/feature/a.ts']);
        },
        result: (spec) =>
          spec.writable
            ? { final: implReceipt(spec) }
            : { final: reviewReceipt(spec, { verdict: 'blocked', summary: '看不到檔案' }) },
      };
    }
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('blocked');
    const item = h.engine.openAttention({
      task_id: task.id,
      kind: 'question',
      question: '審查者看不到檔案，怎麼辦？',
      options: [],
    });
    h.engine.answerAttention(item.id, '我來看', 'cli');
    expect(h.get(task.id).status).toBe('blocked');
  });

  it('a fix run without changes and without a committed head is still rejected no_changes', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.script({}, {}); // impl and fix answer "done" without touching anything
    h.runners.dsh.defaultStep = { start: 'rejected' };
    await h.engine.runUntilIdle();
    const [impl, fix] = h.store.runs.list({ task_id: task.id });
    expect(impl).toMatchObject({ kind: 'impl', outcome: 'rejected', reject_reason: 'no_changes' });
    expect(fix).toMatchObject({ kind: 'fix', outcome: 'rejected', reject_reason: 'no_changes' });
  });
});
