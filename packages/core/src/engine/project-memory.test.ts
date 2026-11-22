import { defaultServiceConfig, type MemorySettings } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import { implReceipt, researchReceipt, reviewReceipt } from '../testing/fake-runner.js';
import { createTestEngine, editing, type TestEngine } from '../testing/harness.js';
import { enqueueEffect } from './effect-queue.js';
import { memoryWrittenKey } from './project-memory.js';

// spec §18 writes: only the service writes, from verified sources, through `memory.write`
// effects (lane `memory`, key = source id, a source is written once), redacted and capped.

const KEY = 'sk-' + 'a'.repeat(30);

function memoryOn(overrides: Partial<MemorySettings> = {}): MemorySettings {
  return { ...defaultServiceConfig().memory, enabled: true, ...overrides };
}

function engineWithMemory(overrides: Partial<MemorySettings> = {}): TestEngine {
  return createTestEngine({ config: { memory: memoryOn(overrides) } });
}

/** impl (with a summary) → review needs_changes (one must_fix) → fix → review pass. */
async function finishedTask(h: TestEngine) {
  h.runners.dsh.script(
    editing(h.git, ['src/feature/a.ts'], {
      result: (spec) => ({ final: implReceipt(spec, { summary: `加上功能 A；金鑰 ${KEY}` }) }),
    }),
    editing(h.git, ['src/feature/b.ts'], {
      result: (spec) => ({ final: implReceipt(spec, { summary: `補上錯誤處理；金鑰 ${KEY}` }) }),
    }),
  );
  h.runners.codex.script(
    {
      result: (spec) => ({
        final: reviewReceipt(spec, {
          verdict: 'needs_changes',
          findings: [
            { file: 'src/feature/a.ts', line: 3, severity: 'must_fix', issue: '缺少錯誤處理' },
            { file: 'src/feature/a.ts', line: 9, severity: 'note', issue: '命名可再短' },
          ],
        }),
      }),
    },
    {},
  );
  const task = h.task({ title: '功能 A' });
  await h.engine.runUntilIdle();
  expect(h.get(task.id).status).toBe('done');
  return task;
}

describe('§18 memory writes', () => {
  it('a done task writes one item: title, scope, receipt summary and the fixed must-fix findings', async () => {
    const h = engineWithMemory();
    const task = await finishedTask(h);
    expect(h.memory.writes).toHaveLength(1);
    const [write] = h.memory.writes;
    expect(write!.projectId).toBe(task.project_id);
    expect(write!.item).toMatchObject({ source: 'task', sourceId: task.id, taskId: task.id });
    const text = write!.item.text;
    expect(text).toContain(`任務完成：功能 A（${task.id}，tier C）`);
    expect(text).toContain('範圍：src/feature/');
    expect(text).toContain('審查要求修正（已修正）：\n- src/feature/a.ts:3：缺少錯誤處理');
    expect(text).not.toContain('命名可再短'); // notes are not fixed findings
    // the last accepted impl/fix receipt's summary, redacted like a log line
    expect(text).toContain('實作摘要：補上錯誤處理；金鑰 [REDACTED]');
    expect(text).not.toContain(KEY);
    expect(h.store.kv.get(memoryWrittenKey(task.id))).toBeDefined();
    expect(h.eventTypes(task.id)).toContain('memory.written');
  });

  it('writes nothing while memory is off, and nothing for a source that is switched off', async () => {
    const off = createTestEngine();
    await finishedTask(off);
    expect(off.memory.writes).toHaveLength(0);
    expect(off.memory.searches).toHaveLength(0);
    expect(off.store.effects.list().some((e) => e.kind === 'memory.write')).toBe(false);

    const noTasks = engineWithMemory({
      write_sources: { task: false, decision: true, human: true, research: true },
    });
    await finishedTask(noTasks);
    expect(noTasks.memory.writes).toHaveLength(0);
  });

  it('caps the item at max_item_chars', async () => {
    const h = engineWithMemory({ max_item_chars: 120 });
    h.runners.dsh.script(
      editing(h.git, ['src/feature/a.ts'], {
        result: (spec) => ({ final: implReceipt(spec, { summary: '很長'.repeat(200) }) }),
      }),
    );
    h.task();
    await h.engine.runUntilIdle();
    const text = h.memory.writes[0]!.item.text;
    expect([...text]).toHaveLength(120);
    expect(text.endsWith('…')).toBe(true);
  });

  it('runs in the lane `memory`; a failed write retries and the source is written once', async () => {
    const h = engineWithMemory();
    h.memory.failures.add = new Error('MemOS timed out');
    const task = await finishedTask(h);
    const effect = h.store.effects.list().find((e) => e.kind === 'memory.write');
    expect(effect).toMatchObject({ key: task.id, attempts: 1 });
    expect(h.eventTypes()).toContain('effect.failed');
    h.memory.failures.add = null;
    h.clock.advance(60_000);
    await h.engine.runUntilIdle();
    expect(h.store.effects.list().some((e) => e.kind === 'memory.write')).toBe(false);
    expect(h.memory.entries).toHaveLength(1);
    // the same source enqueued again (a replay) writes nothing: the kv marker says it is stored
    h.engine.ctx.transact((tx) =>
      enqueueEffect(tx, 'memory.write', task.id, {
        project_id: task.project_id,
        source: 'task',
        source_id: task.id,
        task_id: task.id,
        text: 'again',
        at: tx.now,
      }),
    );
    await h.engine.runUntilIdle();
    expect(h.memory.entries).toHaveLength(1);
    expect(h.memory.writes).toHaveLength(2); // the failed attempt and the successful one
  });

  it('a stored write finishes without writing once memory is off', async () => {
    const h = engineWithMemory();
    const project = h.project();
    h.engine.ctx.transact((tx) =>
      enqueueEffect(tx, 'memory.write', 'n_000001', {
        project_id: project.id,
        source: 'human',
        source_id: 'n_000001',
        task_id: null,
        text: 'x',
        at: tx.now,
      }),
    );
    h.engine.ctx.config.memory = { ...h.engine.ctx.config.memory, enabled: false };
    await h.engine.runUntilIdle();
    expect(h.memory.writes).toHaveLength(0);
    expect(h.store.effects.list()).toHaveLength(0);
  });

  it('answered decisions and worker questions of a task are written; operational items and items without a task are not', async () => {
    const h = engineWithMemory();
    const task = h.task({ queue: false });
    const decision = h.engine.openAttention({
      task_id: task.id,
      kind: 'decision',
      question: '用 SQLite 還是 Postgres？',
      options: ['SQLite', 'Postgres'],
    });
    const general = h.engine.openAttention({
      kind: 'question',
      question: '要不要先停下來？',
      options: [],
    });
    h.engine.answerAttention(decision.id, 'SQLite', 'cli');
    h.engine.answerAttention(general.id, '不要', 'cli');
    await h.engine.runUntilIdle();
    expect(h.memory.writes.map((w) => w.item.source)).toEqual(['decision']);
    expect(h.memory.writes[0]!.item).toMatchObject({ sourceId: decision.id, taskId: task.id });
    expect(h.memory.writes[0]!.item.text).toContain('問：用 SQLite 還是 Postgres？\n答：SQLite');
  });

  it('a done research task writes its recommendation and candidates (labelled as web content)', async () => {
    const h = engineWithMemory();
    h.runners.claude.script({
      result: (spec) => ({
        final: researchReceipt(spec, {
          recommendation: 'adapt_pattern',
          candidates: [
            {
              name: 'mit-queue',
              url: 'https://example.com/q',
              license: 'MIT',
              fit: 'high',
              borrow: '重試',
              caveats: '',
            },
          ],
        }),
      }),
    });
    const research = h.engine.createResearch(
      { project_id: h.project().id, title: '調研：佇列', question: '有哪些佇列？', queue: true },
      { kind: 'leader' },
    );
    await h.engine.runUntilIdle();
    expect(h.get(research.id).status).toBe('done');
    expect(h.memory.writes).toHaveLength(1);
    const { item } = h.memory.writes[0]!;
    expect(item).toMatchObject({ source: 'research', sourceId: research.id });
    expect(item.text).toContain('建議：adapt_pattern');
    expect(item.text).toContain('候選：mit-queue（MIT）');
    expect(item.text).toContain('內容源自網頁');
    // research runs never read the memory (they must not get project content)
    expect(h.memory.searches).toHaveLength(0);
  });

  it('a person adds a note (queued, source human); the leader cannot; 409 while off', async () => {
    const h = engineWithMemory();
    const project = h.project();
    const noteId = h.engine.addMemory(project.id, `記得用 pnpm，不用 npm ${KEY}`);
    expect(noteId).toMatch(/^n_/);
    await h.engine.runUntilIdle();
    expect(h.memory.writes[0]!.item).toMatchObject({ source: 'human', sourceId: noteId });
    expect(h.memory.writes[0]!.item.text).not.toContain(KEY);
    expect(() => h.engine.addMemory(project.id, 'x', { kind: 'leader' })).toThrow(ForbiddenError);
    expect(() => h.engine.addMemory('p_404404', 'x')).toThrow(NotFoundError);
    const off = createTestEngine();
    expect(() => off.engine.addMemory(off.project().id, 'x')).toThrow(ConflictError);
  });

  it('list and delete are human-only; deleting an item of another project is 404', async () => {
    const h = engineWithMemory();
    const a = h.project();
    const b = h.project({ name: 'other', repo_path: '/repos/other' });
    const item = h.memory.seed(a.id, { text: 'a 的記憶' });
    await expect(
      h.engine.listMemory(a.id, { page: 1, pageSize: 10 }, { kind: 'leader' }),
    ).rejects.toThrow(ForbiddenError);
    expect((await h.engine.listMemory(a.id, { page: 1, pageSize: 10 })).total).toBe(1);
    await expect(h.engine.removeMemory(b.id, item.id)).rejects.toThrow(NotFoundError);
    await expect(h.engine.removeMemory(a.id, item.id, { kind: 'leader' })).rejects.toThrow(
      ForbiddenError,
    );
    await h.engine.removeMemory(a.id, item.id);
    expect(h.memory.entries).toHaveLength(0);
    expect(h.eventTypes()).toContain('memory.removed');
    // the leader may search
    h.memory.seed(a.id, { text: '另一筆' });
    expect(await h.engine.searchMemory(a.id, '另一筆')).toHaveLength(1);
  });

  it('MemOS failures on the entrances are 503 unavailable', async () => {
    const h = engineWithMemory();
    const project = h.project();
    h.memory.failures.search = new Error('MemOS answered 500');
    await expect(h.engine.searchMemory(project.id, 'x')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
