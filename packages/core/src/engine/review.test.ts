import type { RunSpec } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { reviewReceipt } from '../testing/fake-runner.js';
import { createTestEngine, editing, type TestEngine } from '../testing/harness.js';

const needsChanges = (spec: RunSpec) => ({
  final: reviewReceipt(spec, {
    verdict: 'needs_changes',
    summary: '少了錯誤處理',
    findings: [
      { file: 'src/feature/a.ts', line: 12, severity: 'must_fix', issue: '未處理 null' },
      { file: 'src/feature/a.ts', line: 0, severity: 'note', issue: '命名可再改' },
    ],
  }),
});

/** Every impl/fix run (any runner) edits an owned file; reviews answer with `review`. */
function scriptAll(
  h: TestEngine,
  review: (spec: RunSpec) => { final: unknown },
  note: (n: number) => string = () => '',
) {
  let n = 0;
  for (const r of Object.values(h.runners)) {
    r.defaultStep = {
      onRun: (spec) => {
        if (spec.writable) h.git.touch(spec.cwd, [`src/feature/f${++n}.ts`]);
      },
      result: (spec) =>
        spec.writable
          ? {
              final: {
                dispatch_id: spec.dispatchId,
                status: 'done',
                summary: 'ok',
                files_changed: [],
                checks: [],
                needs_leader: note(n),
              },
            }
          : review(spec),
    };
  }
}

describe('§14 修正與升級 — review → fix → escalate', () => {
  it('review pass → done; the reviewer alias differs from the implementer', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'B', impl_role: 'impl_B' });
    scriptAll(h, (spec) => ({ final: reviewReceipt(spec) }));
    await h.engine.runUntilIdle();
    const [impl, review] = h.store.runs.list({ task_id: task.id });
    expect(impl).toMatchObject({ role: 'impl_B', model_alias: 'gpt-sol' });
    expect(review).toMatchObject({ role: 'review_B', kind: 'review' });
    expect(review!.model_alias).not.toBe(impl!.model_alias);
    expect(h.get(task.id).status).toBe('done');
  });

  it('review_C skips gpt-sol when impl_B implemented with gpt-sol', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'C', impl_role: 'impl_B' });
    scriptAll(h, (spec) => ({ final: reviewReceipt(spec) }));
    await h.engine.runUntilIdle();
    const [impl, review] = h.store.runs.list({ task_id: task.id });
    expect(impl!.model_alias).toBe('gpt-sol');
    expect(review).toMatchObject({ role: 'review_C', model_alias: 'kimi-pro' });
  });

  it('needs_changes → fix run with the must-fix list; fix_rounds counts up', async () => {
    const h = createTestEngine();
    const task = h.task();
    let reviews = 0;
    scriptAll(h, (spec) => (++reviews === 1 ? needsChanges(spec) : { final: reviewReceipt(spec) }));
    await h.engine.runUntilIdle();
    const runs = h.store.runs.list({ task_id: task.id });
    expect(runs.map((r) => r.kind)).toEqual(['impl', 'review', 'fix', 'review']);
    const fixSpec = h.runners.dsh.calls[1]!;
    expect(fixSpec.prompt).toContain('`src/feature/a.ts:12` 未處理 null');
    expect(fixSpec.prompt).not.toContain('命名可再改');
    const done = h.get(task.id);
    expect(done).toMatchObject({ status: 'done', fix_rounds: 1, fix_notes: null });
    // two service commits: impl and fix
    expect(h.git.calls.filter((c) => c.method === 'commitFiles')).toHaveLength(2);
  });

  it('after max_fix_rounds_before_escalate the next failure escalates impl_C → impl_B', async () => {
    const h = createTestEngine();
    const task = h.task();
    let reviews = 0;
    scriptAll(h, (spec) => (++reviews <= 3 ? needsChanges(spec) : { final: reviewReceipt(spec) }));
    await h.engine.runUntilIdle();
    const runs = h.store.runs.list({ task_id: task.id }).filter((r) => r.kind !== 'review');
    expect(runs.map((r) => [r.kind, r.role])).toEqual([
      ['impl', 'impl_C'],
      ['fix', 'impl_C'],
      ['fix', 'impl_C'],
      ['fix', 'impl_B'],
    ]);
    const escalated = h.store.events.listAfter(0).find((e) => e.type === 'task.escalated');
    expect(escalated?.data).toEqual({ from_role: 'impl_C', to_role: 'impl_B', fix_rounds: 2 });
    expect(h.get(task.id)).toMatchObject({ status: 'done', impl_role: 'impl_B', fix_rounds: 1 });
  });

  it('with nowhere to escalate (impl_A) the task is blocked', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'A', impl_role: 'impl_A' });
    scriptAll(h, needsChanges);
    await h.engine.runUntilIdle();
    const t = h.get(task.id);
    expect(t.status).toBe('blocked');
    expect(t.blocked_reason).toContain('無處可升級');
    expect(t.fix_rounds).toBe(2);
    expect(h.notifier.sent.map((o) => o.kind)).toContain('task_blocked');
  });

  it('a fix-limit block asks the person; the answer reaches the worker with a fresh budget', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'A', impl_role: 'impl_A' });
    let reviews = 0;
    const prompts: string[] = [];
    scriptAll(h, (spec) => (++reviews <= 3 ? needsChanges(spec) : { final: reviewReceipt(spec) }));
    for (const r of Object.values(h.runners)) {
      const run = r.run.bind(r);
      r.run = (spec, ...rest) => {
        prompts.push(spec.prompt);
        return run(spec, ...rest);
      };
    }
    await h.engine.runUntilIdle();
    const [item] = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
    expect(item).toMatchObject({ kind: 'decision', topic: 'fix_limit', options: [] });
    expect(item!.question).toContain('未處理 null');
    expect(item!.question).toContain('重新給 2 輪修正額度');

    const before = prompts.length;
    h.engine.answerAttention(item!.id, '命名問題先不管，只修 null', 'cli');
    expect(h.get(task.id)).toMatchObject({ status: 'queued', fix_rounds: 0, blocked_reason: null });
    await h.engine.runUntilIdle();
    // the resumed fix run passed review: no round was counted against the fresh budget
    expect(h.get(task.id)).toMatchObject({ status: 'done', fix_rounds: 0 });
    expect(prompts.slice(before).some((p) => p.includes('命名問題先不管，只修 null'))).toBe(true);
  });

  it('notes left by successful runs do not hold up the fix-limit answer; they are superseded', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'A', impl_role: 'impl_A' });
    let reviews = 0;
    scriptAll(
      h,
      (spec) => (++reviews <= 3 ? needsChanges(spec) : { final: reviewReceipt(spec) }),
      (n) => (n <= 3 ? `第 ${n} 輪的說明：介面改了` : ''),
    );
    await h.engine.runUntilIdle();
    const open = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
    expect(open.map((a) => a.topic).sort()).toEqual([
      'fix_limit',
      'worker_question',
      'worker_question',
      'worker_question',
    ]);
    const decision = open.find((a) => a.topic === 'fix_limit')!;
    h.engine.answerAttention(decision.id, '照目前做法收尾', 'cli');
    expect(h.get(task.id)).toMatchObject({ status: 'queued', fix_rounds: 0 });
    const notes = open.filter((a) => a.topic === 'worker_question');
    for (const a of notes) expect(h.store.attention.get(a.id)?.status).toBe('superseded');
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
  });

  it('a person retrying a fix-limit block gives it a fresh budget; the open item is superseded', async () => {
    const h = createTestEngine();
    const task = h.task({ tier: 'A', impl_role: 'impl_A' });
    scriptAll(h, needsChanges);
    await h.engine.runUntilIdle();
    const [item] = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
    h.engine.retryTask(task.id);
    expect(h.get(task.id)).toMatchObject({ status: 'queued', fix_rounds: 0 });
    expect(h.store.attention.get(item!.id)?.status).toBe('superseded');
  });

  it('a rejection (checks failing) follows the same fix → escalate path', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.checks.setResult('test', { passed: false, tail: 'FAIL a.test.ts' });
    scriptAll(h, (spec) => ({ final: reviewReceipt(spec) }));
    await h.engine.runUntilIdle();
    const roles = h.store.runs
      .list({ task_id: task.id })
      .map((r) => `${r.kind}:${r.role}:${r.outcome}`);
    expect(roles).toEqual([
      'impl:impl_C:rejected',
      'fix:impl_C:rejected',
      'fix:impl_C:rejected',
      'fix:impl_B:rejected',
      'fix:impl_B:rejected',
      'fix:impl_A:rejected',
      'fix:impl_A:rejected',
    ]);
    expect(h.get(task.id)).toMatchObject({ status: 'blocked', impl_role: 'impl_A' });
  });

  it('review verdict blocked → task blocked', async () => {
    const h = createTestEngine();
    const task = h.task();
    scriptAll(h, (spec) => ({
      final: reviewReceipt(spec, { verdict: 'blocked', summary: '看不到檔案' }),
    }));
    await h.engine.runUntilIdle();
    expect(h.get(task.id)).toMatchObject({
      status: 'blocked',
      blocked_reason: '審查回報 blocked：看不到檔案',
    });
  });

  it('an invalid review receipt retries the review, not the implementation', async () => {
    const h = createTestEngine();
    const task = h.task();
    let reviews = 0;
    scriptAll(h, (spec) =>
      ++reviews === 1 ? { final: { verdict: 'maybe' } } : { final: reviewReceipt(spec) },
    );
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('review');
    h.clock.advance(5000);
    await h.engine.runUntilIdle();
    expect(h.store.runs.list({ task_id: task.id }).map((r) => r.kind)).toEqual([
      'impl',
      'review',
      'review',
    ]);
    expect(h.get(task.id).status).toBe('done');
  });
});

describe('human approve / reject', () => {
  it('approve finishes a task in review and stops the pending review run', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.runners.codex.script({ hold: true });
    await h.engine.drain();
    expect(h.get(task.id).status).toBe('review');
    const review = h.store.runs.list({ task_id: task.id })[1]!;
    h.engine.approveTask(task.id);
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
    expect(h.store.runs.get(review.id)).toMatchObject({ state: 'stopped', outcome: 'cancelled' });
    expect(h.runners.codex.held()).toEqual([]); // aborted through run.stop
  });

  it('reject turns the note into a fix run', async () => {
    const h = createTestEngine();
    const task = h.task();
    h.runners.dsh.script(
      editing(h.git, ['src/feature/a.ts']),
      editing(h.git, ['src/feature/b.ts']),
    );
    h.runners.codex.script({ hold: true });
    await h.engine.drain();
    h.engine.rejectTask(task.id, '請改用 async API');
    await h.engine.runUntilIdle();
    const fix = h.store.runs.list({ task_id: task.id }).find((r) => r.kind === 'fix');
    expect(fix).toBeDefined();
    expect(h.runners.dsh.calls[1]!.prompt).toContain('人工退回：請改用 async API');
    expect(h.get(task.id).status).toBe('done');
  });
});
