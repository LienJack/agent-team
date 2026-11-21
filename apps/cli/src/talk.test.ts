import type { Task } from '@agent-team/client';
import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

// `team ask` (waits however long the leader takes; Ctrl-C stops waiting), `team task reassign`
// (role checked against GET /api/roles) and `team roles`.

const T0 = '2026-11-21T00:00:00.000Z';
const task: Task = {
  id: 't_000001',
  project_id: 'p_000001',
  parent_id: null,
  title: '加一個功能',
  tier: 'C',
  ticket_md: '# 派工單',
  owned_paths: ['src/a'],
  priority: 0,
  status: 'draft',
  impl_role: 'impl_C',
  fix_rounds: 0,
  attempts: 0,
  blocked_reason: null,
  version: 1,
  current_run_id: null,
  retry_at: null,
  fix_notes: null,
  recovery_note: null,
  created_at: T0,
  updated_at: T0,
};

describe('team ask / reassign / roles', () => {
  const leaderIdle = { state: 'idle' as const, last_activity_at: null, available: true };

  it('ask sends source cli with a client message id and waits for the reply', async () => {
    let body: unknown;
    const io = captureIo(
      fakeClient({
        sendLeaderMessage: async (b) => {
          body = b;
          return {
            message_id: 'm_1',
            pending: false,
            reply: '收到',
            reply_message_id: 'm_2',
            leader: leaderIdle,
          };
        },
      }),
    );
    expect(await runCli(['ask', '進度如何？'], io)).toBe(0);
    expect(body).toEqual({ text: '進度如何？', source: 'cli', client_msg_id: 'msg-1', wait: true });
    expect(io.text()).toBe('收到\n');
  });

  it('ask keeps waiting past the server cap (pending) by polling the message', async () => {
    let polls = 0;
    const inbound = {
      id: 'm_1',
      channel: 'leader' as const,
      direction: 'in' as const,
      source: 'cli' as const,
      body: '長任務',
      client_msg_id: 'msg-1',
      ref: null,
      status: 'new' as const,
      seq: 1,
      created_at: T0,
    };
    const io = captureIo(
      fakeClient({
        sendLeaderMessage: async () => ({
          message_id: 'm_1',
          pending: true,
          reply: null,
          reply_message_id: null,
          leader: { ...leaderIdle, state: 'busy' },
        }),
        leaderMessage: async () => {
          polls += 1;
          return {
            message: inbound,
            reply:
              polls < 2
                ? null
                : { ...inbound, id: 'm_2', direction: 'out', body: '做完了', ref: 'm_1' },
            leader: leaderIdle,
          };
        },
      }),
      { askPollMs: 1 },
    );
    expect(await runCli(['ask', '長任務'], io)).toBe(0);
    expect(io.text()).toBe('做完了\n');
    expect(polls).toBe(2);
    expect(io.err.join('')).toMatch(/leader 還在處理 m_1/);
  });

  it('ask: Ctrl-C stops waiting, keeps the message queued, exit 130', async () => {
    const controller = new AbortController();
    const io = captureIo(
      fakeClient({
        sendLeaderMessage: async () => ({
          message_id: 'm_1',
          pending: true,
          reply: null,
          reply_message_id: null,
          leader: leaderIdle,
        }),
        leaderMessage: async () => {
          controller.abort();
          throw new Error('aborted');
        },
      }),
      { askPollMs: 1, signal: controller.signal },
    );
    expect(await runCli(['ask', 'hi'], io)).toBe(130);
    expect(io.err.join('')).toMatch(/stopped waiting for m_1: the message is stored/);
  });

  it('task reassign checks the role against GET /api/roles first', async () => {
    const roles = [
      {
        name: 'impl_A',
        description: null,
        model_alias: 'opus',
        runner: 'claude' as const,
        slots: 1,
        enabled: true,
        fallback: [],
      },
      {
        name: 'gate',
        description: '判定',
        model_alias: 'jev',
        runner: 'jev' as const,
        slots: 4,
        enabled: false,
        fallback: ['deepseek-flash'],
      },
    ];
    const reassigned: string[] = [];
    const client = fakeClient({
      roles: async () => roles,
      reassignTask: async (id, role) => {
        reassigned.push(`${id}:${role}`);
        return { ...task, impl_role: role };
      },
    });
    const ok = captureIo(client);
    expect(await runCli(['task', 'reassign', 't_000001', 'impl_A'], ok)).toBe(0);
    expect(reassigned).toEqual(['t_000001:impl_A']);
    for (const [role, why] of [
      ['impl_Z', /unknown role "impl_Z"; one of: impl_A/],
      ['gate', /disabled role "gate"/],
    ] as const) {
      const io = captureIo(client);
      expect(await runCli(['task', 'reassign', 't_000001', role], io)).toBe(2);
      expect(io.err.join('')).toMatch(why);
    }
    expect(reassigned).toHaveLength(1);
    const listed = captureIo(client);
    expect(await runCli(['roles'], listed)).toBe(0);
    expect(listed.text()).toBe(
      'impl_A  opus (claude) ×1\ngate  jev (jev) ×4  → deepseek-flash  [disabled]  判定\n',
    );
  });
});
