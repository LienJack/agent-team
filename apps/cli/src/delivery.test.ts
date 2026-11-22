import { connectionError, TeamApiError, type Project, type Task } from '@agent-team/client';
import { deliveryReport } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { deliveryLine } from './delivery.js';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

// docs/adr/0022 §1: the state-changing task commands always print an explicit `delivery` and the
// generated `report`, in --json and plain text, refusals included; exit codes stay.

const T0 = '2026-11-21T00:00:00.000Z';
const project: Project = {
  id: 'p_000001',
  name: 'demo',
  repo_path: '/repos/demo',
  base_branch: 'main',
  checks: [],
  allow_network: false,
  created_at: T0,
};
const task: Task = {
  id: 't_000001',
  project_id: 'p_000001',
  parent_id: null,
  kind: 'impl',
  title: '加一個功能',
  tier: 'C',
  ticket_md: '# 派工單',
  owned_paths: ['src/a'],
  research_refs: [],
  priority: 0,
  status: 'running',
  impl_role: 'impl_C',
  fix_rounds: 0,
  leader_retries: 0,
  attempts: 0,
  blocked_reason: null,
  version: 2,
  current_run_id: 'r_000001',
  retry_at: null,
  fix_notes: null,
  recovery_note: null,
  created_at: T0,
  updated_at: T0,
};
const running = { state: 'running' as const, waiting: null, run_id: 'r_000001', reason: null };
const addArgv = ['task', 'add', '--project', 'demo', '--title', 'T', '--tier', 'C'];

describe('deliveryLine', () => {
  it('names the state and what it waits for', () => {
    expect(deliveryLine(running)).toBe('delivery: running (run r_000001)');
    expect(
      deliveryLine({
        state: 'queued',
        waiting: {
          reason: 'path_overlap',
          detail: null,
          blocking_task_id: 't_000009',
          retry_at: null,
        },
        run_id: null,
        reason: null,
      }),
    ).toBe('delivery: queued (waiting: path_overlap — behind t_000009)');
    expect(
      deliveryLine({
        state: 'queued',
        waiting: {
          reason: 'runner_cooldown',
          detail: 'impl_C: no candidate',
          blocking_task_id: null,
          retry_at: '2026-11-21T00:15:00.000Z',
        },
        run_id: null,
        reason: null,
      }),
    ).toBe(
      'delivery: queued (waiting: runner_cooldown — impl_C: no candidate, until 2026-11-21T00:15:00.000Z)',
    );
    expect(deliveryLine({ state: 'draft', waiting: null, run_id: null, reason: null })).toBe(
      'delivery: draft',
    );
  });
});

describe('task commands print delivery and report', () => {
  it('retry: plain text and --json carry the delivery the server reported', async () => {
    const report = deliveryReport(task, running);
    const client = fakeClient({
      taskActionResult: async () => ({ task, delivery: running, report }),
    });
    const plain = captureIo(client);
    expect(await runCli(['task', 'retry', 't_000001'], plain)).toBe(0);
    expect(plain.text()).toBe(
      [
        't_000001 [running] C impl_C 加一個功能',
        'delivery: running (run r_000001)',
        `report: ${report}`,
        '',
      ].join('\n'),
    );
    const json = captureIo(client);
    expect(await runCli(['--json', 'task', 'retry', 't_000001'], json)).toBe(0);
    // the task fields stay at the top (older scripts keep working), plus delivery and report
    expect(JSON.parse(json.text())).toEqual({ ...task, delivery: running, report });
  });

  it('a refused command: not_accepted with the reason, nothing created; exit code 1', async () => {
    const conflict = new TeamApiError(
      {
        code: 'conflict',
        message: 'only blocked or failed tasks can be retried (task t_000001 is queued)',
      },
      409,
    );
    const client = fakeClient({ taskActionResult: async () => Promise.reject(conflict) });
    const plain = captureIo(client);
    expect(await runCli(['task', 'retry', 't_000001'], plain)).toBe(1);
    expect(plain.err.join('')).toContain('error: only blocked or failed tasks can be retried');
    expect(plain.text()).toBe(
      [
        `delivery: not_accepted (conflict: ${conflict.message})`,
        `report: 請求未被受理（conflict）：${conflict.message}。沒有建立或改變任何任務。`,
        '',
      ].join('\n'),
    );
    const json = captureIo(client);
    expect(await runCli(['--json', 'task', 'retry', 't_000001'], json)).toBe(1);
    expect(JSON.parse(json.text())).toEqual({
      error: { code: 'conflict', message: conflict.message },
      delivery: {
        state: 'not_accepted',
        waiting: null,
        run_id: null,
        reason: `conflict: ${conflict.message}`,
      },
      report: `請求未被受理（conflict）：${conflict.message}。沒有建立或改變任何任務。`,
    });
  });

  it('task add when the service is unreachable: not known whether it was accepted; exit code 2', async () => {
    const down = connectionError('http://127.0.0.1:4517', new Error('ECONNREFUSED'));
    const io = captureIo(
      fakeClient({
        listProjects: async () => [project],
        createTaskResult: async () => Promise.reject(down),
      }),
      { readStdin: async () => '# 派工單' },
    );
    expect(await runCli([...addArgv, '--paths', 'src/a', '-'], io)).toBe(2);
    expect(io.text()).toMatch(/^delivery: not_accepted \(unavailable: /);
    expect(io.text()).toMatch(
      /\nreport: 無法連線到服務（.+），無法確認請求是否已受理；先用 team task list 確認。\n$/,
    );
  });

  it('task add with a usage problem: not_accepted before any request; exit code 2', async () => {
    const io = captureIo(fakeClient({}), { readStdin: async () => '   ' });
    expect(await runCli([...addArgv, '--paths', 'src/a', '-'], io)).toBe(2);
    expect(io.err.join('')).toContain('error: the ticket is empty');
    expect(io.text()).toBe(
      [
        'delivery: not_accepted (usage: the ticket is empty)',
        'report: 請求未被受理（usage）：the ticket is empty。沒有建立或改變任何任務。',
        '',
      ].join('\n'),
    );
  });

  it('research add refused while research is off: not_accepted, exit code 1', async () => {
    const off = new TeamApiError({ code: 'conflict', message: 'research is off' }, 409);
    const io = captureIo(
      fakeClient({
        listProjects: async () => [project],
        createResearchResult: async () => Promise.reject(off),
      }),
    );
    const argv = ['research', 'add', 'demo', '--title', 'R', '--question', 'Q?'];
    expect(await runCli(argv, io)).toBe(1);
    expect(io.text()).toContain('delivery: not_accepted (conflict: research is off)');
    expect(io.text()).toContain('report: 請求未被受理（conflict）：research is off。');
  });
});
