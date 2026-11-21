import { editing } from '@agent-team/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestService, type TestService } from '../testing/harness.js';
import { LEADER_RECEIPTS_CURSOR_KEY } from './types.js';

let h: TestService;

beforeEach(() => {
  h = createTestService();
});
afterEach(async () => {
  await h.cleanup();
});

describe('resumeBrief (spec §9 GET /resume, no model)', () => {
  it('lists running tasks, unread receipts and open attention', async () => {
    const { engine } = h.service;
    const project = engine.createProject({ name: 'demo', repo_path: '/repos/demo' });
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.runners.codex.script({ hold: true });
    const task = engine.createTask({
      project_id: project.id,
      title: '加入登入頁',
      tier: 'C',
      ticket_md: '# x',
      owned_paths: ['src/feature/'],
      queue: true,
    });
    await engine.drain();
    engine.openAttention({ question: '要用哪個框架？', options: ['React', 'Vue'] });

    const brief = h.service.leader.resumeBrief();
    expect(brief).toContain('## 進行中的任務（1）');
    expect(brief).toContain(`\`${task.id}\` [review] 加入登入頁`);
    expect(brief).toContain('## 未讀回執（1）');
    expect(brief).toMatch(/impl：done/);
    expect(brief).toContain('## 待決事項（1）');
    expect(brief).toContain('要用哪個框架？ — 選項：React／Vue');

    // receipts read by the leader (cursor in kv) are no longer listed
    h.store.kv.set(LEADER_RECEIPTS_CURSOR_KEY, h.clock.now().toISOString());
    expect(h.service.leader.resumeBrief()).toContain('## 未讀回執（0）');
  });

  it('without a leader runtime the leader is offline (disabled) and refuses with unavailable', async () => {
    expect(h.service.leader.status()).toMatchObject({
      state: 'offline',
      last_activity_at: null,
      available: false,
      reason: 'disabled',
    });
    const { message } = h.service.engine.recordMessage({
      channel: 'leader',
      direction: 'in',
      source: 'cli',
      body: 'hi',
    });
    await expect(
      h.service.leader.handleMessage(message, { duplicate: false }),
    ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/disabled/) });
    expect(() => h.service.leader.notify([])).not.toThrow();
  });

  it('a disabled hub delivers nothing, so no outbox rows are written', async () => {
    expect(h.service.hub.delivering).toBe(false);
    h.service.engine.openAttention({ question: 'Q?' });
    expect(h.store.outbox.list()).toEqual([]);
  });
});
