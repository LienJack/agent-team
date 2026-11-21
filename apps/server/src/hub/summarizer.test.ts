import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeRunner,
  InMemoryRunnerRegistry,
  ManualClock,
  testModelsConfig,
} from '@agent-team/core/testing';
import { defaultHealth } from '@agent-team/core';
import type { RunResult } from '@agent-team/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { attentionNotice } from './hub.js';
import { capText, condense, roleSummarizer, summaryPrompt, UNSUMMARIZED } from './summarizer.js';

// spec §10 整理：role hub_summarizer through its runner (a fake here), a fixed instruction,
// a hard cap; failure → truncated original 「（未整理）」; short texts never reach a model.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(result: RunResult) {
  dir = mkdtempSync(join(tmpdir(), 'team-summary-'));
  const dsh = new FakeRunner('dsh');
  dsh.defaultStep = { result };
  const registry = new InMemoryRunnerRegistry().register(dsh);
  const models = testModelsConfig((m) => {
    m.roles['hub_summarizer'] = { use: 'deepseek-flash', fallback: ['glm-flash'], slots: 2 };
  });
  const summarize = roleSummarizer({
    runners: registry,
    models,
    quota: () => ({ dsh: { ...defaultHealth('dsh'), available: true } }),
    clock: new ManualClock(),
    dataDir: dir,
  });
  return { dsh, summarize };
}

describe('§10 hub_summarizer', () => {
  it('calls the role runner read-only with the fixed instruction and returns the summary', async () => {
    const { dsh, summarize } = setup({ final: { summary: '完成 2 項；下一步：審查。' } });
    expect(await summarize('一大段 leader 回覆', 300)).toBe('完成 2 項；下一步：審查。');
    const spec = dsh.calls[0]!;
    expect(spec).toMatchObject({ model: 'deepseek-flash', writable: false });
    expect(spec.prompt).toBe(summaryPrompt('一大段 leader 回覆', 300));
    expect(spec.prompt).toMatch(/繁體中文，最多 300 字/);
    expect(spec.prompt).toMatch(/結果、關鍵數字、下一步、阻礙/);
    expect(spec.prompt).toMatch(/不要提到任何 agent、session/);
    expect(spec.prompt).toMatch(/不要貼原始日誌/);
    expect(spec.schema).toMatchObject({ required: ['summary'] });
  });

  it('throws on a runner error or an empty summary (the caller falls back)', async () => {
    const failing = setup({ error: { kind: 'crash', message: 'boom' } });
    await expect(failing.summarize('x', 10)).rejects.toThrow(/crash: boom/);
    rmSync(dir!, { recursive: true, force: true });
    const empty = setup({ final: { summary: '  ' } });
    await expect(empty.summarize('x', 10)).rejects.toThrow(/empty/);
  });

  it('condense: pass-through at or under the threshold, capped summary, marked fallback', async () => {
    const never = async () => {
      throw new Error('must not be called');
    };
    expect(await condense('短訊息', { threshold: 3, maxChars: 10, summarize: never })).toEqual({
      text: '短訊息',
      summarized: null,
    });
    const ok = await condense('1234567890', {
      threshold: 5,
      maxChars: 6,
      summarize: async () => '整理後的長長長長內容',
    });
    expect(ok).toEqual({ text: capText('整理後的長長長長內容', 6), summarized: true });
    expect([...ok.text]).toHaveLength(6);
    const bad = await condense('一二三四五六七八九十', {
      threshold: 5,
      maxChars: 8,
      summarize: never,
    });
    expect(bad).toEqual({ text: `一二…${UNSUMMARIZED}`, summarized: false });
    expect([...bad.text]).toHaveLength(8);
  });

  it('attention notices keep question and options verbatim (no model)', () => {
    const notice = attentionNotice({
      id: 'a_000001',
      task_id: null,
      kind: 'decision',
      question: '要花 US$10 嗎？',
      options: ['先跑 3 條（上限 US$10）', "取消 '全部'"],
      status: 'open',
      answer: null,
      answered_via: null,
      created_at: '2026-11-21T00:00:00.000Z',
      answered_at: null,
    });
    expect(notice).toBe(
      "需要你決定：要花 US$10 嗎？\n選項：\n- 先跑 3 條（上限 US$10）\n- 取消 '全部'\n（回覆其中一個選項的原文）",
    );
  });
});
