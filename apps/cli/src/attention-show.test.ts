import type { Attention } from '@agent-team/client';
import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

const long = `「MVP1-1」（t_000001）修正 2 輪後仍未通過。${'很長的說明。'.repeat(40)}`;
const item: Attention = {
  id: 'a_000001',
  task_id: 't_000001',
  kind: 'decision',
  topic: 'fix_limit',
  question: long,
  options: [],
  status: 'answered',
  answer: '只修 null',
  answered_via: 'cli',
  created_at: '2026-11-21T00:00:00.000Z',
  answered_at: '2026-11-21T00:05:00.000Z',
};

describe('team attention show', () => {
  it('prints the whole question and the answer; an unknown id is not found', async () => {
    const queries: unknown[] = [];
    const client = fakeClient({
      listAttention: async (q) => {
        queries.push(q);
        return [item];
      },
    });
    const io = captureIo(client);
    expect(await runCli(['attention', 'show', 'a_000001'], io)).toBe(0);
    expect(queries).toEqual([undefined]); // every status, not only open
    expect(io.text()).toContain(long);
    expect(io.text()).toContain('topic fix_limit task t_000001');
    expect(io.text()).toContain('answer (cli, 2026-11-21T00:05:00.000Z):\n只修 null');
    expect(await runCli(['attention', 'show', 'a_zzzzzz'], captureIo(client))).toBe(1);
  });
});
