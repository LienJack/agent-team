import { describe, expect, it } from 'vitest';
import { createTestEngine, editing } from '../testing/harness.js';
import { acceptanceSection, REVIEW_DIFF_MAX_CHARS } from './prompt.js';

// docs/adr/0008: read-only reviewers cannot run git, so the review prompt carries the diff.

const TICKET = [
  '# 加入 a 功能',
  '在 src/feature/ 加 a.ts。',
  '',
  '## 驗收標準',
  '- a() 回傳 1',
  '- 有單元測試',
  '',
  '## 備註',
  '不要動其他模組。',
].join('\n');

describe('review prompt carries the diff, the ticket and the acceptance text', () => {
  it('puts --stat, the diff of base..head and the acceptance section into the review run', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts', 'src/feature/a.test.ts']));
    const task = h.task({ ticket_md: TICKET });
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');

    const review = h.runners.codex.calls.find((s) => !s.writable)!;
    const ws = h.store.workspaces.findCurrentByTask(task.id)!;
    expect(h.git.calls.find((c) => c.method === 'reviewDiff')?.input).toEqual({
      worktreePath: ws.path,
      baseSha: ws.base_sha,
      headSha: ws.head_sha,
      maxChars: REVIEW_DIFF_MAX_CHARS,
    });
    const p = review.prompt;
    expect(p).toContain('## 派工單原文');
    expect(p).toContain(
      `## 驗收標準\n\n<<<DATA acceptance#${review.dispatchId}>>>\n- a() 回傳 1\n- 有單元測試\n<<<END acceptance#${review.dispatchId}>>>`,
    );
    expect(p).not.toMatch(/## 驗收標準\n\n[^#]*不要動其他模組/);
    expect(p).toContain(`## 變更（\`${ws.base_sha}..${ws.head_sha}\`）`);
    expect(p).toContain(' src/feature/a.ts | 1 +');
    expect(p).toContain('diff --git a/src/feature/a.test.ts b/src/feature/a.test.ts');
    expect(p).toContain('不需要執行 git');
    expect(p).not.toContain('已截斷');
    // the schema comes last, after the diff
    expect(p.indexOf('## 回執 schema')).toBeGreaterThan(p.indexOf('diff --git'));
  });

  it('notes omitted files when the diff exceeds the cap, keeping the stat', async () => {
    const h = createTestEngine();
    h.git.diffLine = (f) => (f.endsWith('big.ts') ? 'x'.repeat(REVIEW_DIFF_MAX_CHARS) : 'ok');
    h.runners.dsh.script(editing(h.git, ['src/feature/big.ts', 'src/feature/small.ts']));
    const task = h.task();
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
    const p = h.runners.codex.calls.find((s) => !s.writable)!.prompt;
    expect(p).toContain(' src/feature/big.ts | 1 +');
    expect(p).toContain('diff --git a/src/feature/small.ts');
    expect(p).not.toContain('diff --git a/src/feature/big.ts');
    expect(p).toMatch(/已截斷：下列 1 個檔案.*\n.*`src\/feature\/big\.ts`/);
    expect(p.length).toBeLessThan(REVIEW_DIFF_MAX_CHARS + 20_000);
  });

  it('a failing diff rejects the review dispatch (attempt counted), then retries', async () => {
    const h = createTestEngine();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.git.failNext('reviewDiff');
    const task = h.task();
    await h.engine.runUntilIdle();
    expect(h.get(task.id)).toMatchObject({ status: 'review', attempts: 1 });
    expect(h.eventTypes(task.id)).toContain('task.dispatch_failed');
    h.clock.advance(60_000);
    await h.engine.runUntilIdle();
    expect(h.get(task.id).status).toBe('done');
  });
});

describe('acceptanceSection', () => {
  it('takes the body under the first acceptance heading up to the next same-level heading', () => {
    expect(acceptanceSection(TICKET)).toBe('- a() 回傳 1\n- 有單元測試');
    expect(
      acceptanceSection('# T\n### Acceptance criteria\n- x\n#### detail\n- y\n## Next\nz'),
    ).toBe('- x\n#### detail\n- y');
    expect(acceptanceSection('# T\n做一件事')).toBeNull();
    expect(acceptanceSection('# T\n## 完成標準\n\n## 其他')).toBeNull();
  });
});
