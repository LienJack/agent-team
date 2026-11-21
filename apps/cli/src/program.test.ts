import {
  TeamApiError,
  type Attention,
  type Project,
  type Task,
  type TaskDetail,
} from '@agent-team/client';
import type { EventRecord } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { eventLine, formatStatus } from './format.js';
import { serverEntry } from './node-io.js';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

const T0 = '2026-11-21T00:00:00.000Z';
const project: Project = {
  id: 'p_000001',
  name: 'demo',
  repo_path: '/repos/demo',
  base_branch: 'main',
  checks: [{ name: 'test', cmd: 'pnpm test' }],
  allow_network: false,
  created_at: T0,
};
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
  leader_retries: 0,
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
const attention: Attention = {
  id: 'a_000001',
  task_id: null,
  kind: 'decision',
  question: '要哪個？',
  options: ['A', 'B'],
  status: 'open',
  answer: null,
  answered_via: null,
  created_at: T0,
  answered_at: null,
};

describe('team — argument parsing', () => {
  it('task add: ticket from file, paths split, project by name, --queue', async () => {
    let body: unknown;
    const client = fakeClient({
      listProjects: async () => [project],
      createTask: async (b) => {
        body = b;
        return { ...task, status: 'queued' };
      },
    });
    const io = captureIo(client, { readFile: async (p) => `ticket from ${p}` });
    const code = await runCli(
      [
        'task',
        'add',
        '--project',
        'demo',
        '--title',
        'T',
        '--tier',
        'C',
        '--paths',
        'src/a, src/b  docs',
        '--ticket-file',
        't.md',
        '--queue',
      ],
      io,
    );
    expect(code).toBe(0);
    expect(body).toEqual({
      project_id: 'p_000001',
      title: 'T',
      tier: 'C',
      ticket_md: 'ticket from /work/t.md',
      owned_paths: ['src/a', 'src/b', 'docs'],
      queue: true,
    });
    expect(io.text()).toBe('t_000001 [queued] C impl_C 加一個功能\n');
  });

  it('task add: "-" reads stdin; the ticket source must be exactly one', async () => {
    let ticket = '';
    const client = fakeClient({
      createTask: async (b) => {
        ticket = b.ticket_md;
        return task;
      },
    });
    const base = [
      'task',
      'add',
      '--project',
      'p_000001',
      '--title',
      'T',
      '--tier',
      'B',
      '--paths',
      'a',
    ];
    const io = captureIo(client, { readStdin: async () => 'from stdin' });
    expect(await runCli([...base, '-'], io)).toBe(0);
    expect(ticket).toBe('from stdin');
    const neither = captureIo(client);
    expect(await runCli(base, neither)).toBe(2);
    expect(neither.err.join('')).toMatch(/exactly one of --ticket-file F or -/);
    expect(await runCli([...base, '-', '--ticket-file', 'x'], captureIo(client))).toBe(2);
  });

  it('usage errors exit 2: bad tier, missing option, unknown command, bad --check, bad --after', async () => {
    const client = fakeClient({});
    const cases = [
      ['task', 'add', '--project', 'p', '--title', 'T', '--tier', 'Z', '--paths', 'a', '-'],
      ['task', 'add', '--title', 'T'],
      ['frobnicate'],
      ['project', 'add', 'demo', '/r', '--check', 'no-equals-sign'],
      ['watch', '--after', 'soon'],
      ['attention', 'list', '--status', 'maybe'],
    ];
    for (const argv of cases) {
      const io = captureIo(client);
      expect({ argv, code: await runCli(argv, io) }).toEqual({ argv, code: 2 });
    }
  });

  it('project add resolves a relative repo and parses repeatable --check', async () => {
    let body: unknown;
    const client = fakeClient({
      createProject: async (b) => {
        body = b;
        return project;
      },
    });
    const io = captureIo(client);
    const code = await runCli(
      [
        'project',
        'add',
        'demo',
        '../demo',
        '--base',
        'dev',
        '--check',
        'test=pnpm test',
        '--check',
        'lint = pnpm lint',
      ],
      io,
    );
    expect(code).toBe(0);
    expect(body).toEqual({
      name: 'demo',
      repo_path: '/demo',
      base_branch: 'dev',
      checks: [
        { name: 'test', cmd: 'pnpm test' },
        { name: 'lint', cmd: 'pnpm lint' },
      ],
      allow_network: false,
    });
    expect(io.text()).toBe('p_000001 demo /repos/demo (main, 1 check)\n');
  });

  it('project add --allow-network lets sandboxed workers of the project use the network', async () => {
    const bodies: unknown[] = [];
    const client = fakeClient({
      createProject: async (b) => {
        bodies.push(b);
        return project;
      },
    });
    expect(
      await runCli(['project', 'add', 'demo', '/demo', '--allow-network'], captureIo(client)),
    ).toBe(0);
    expect(await runCli(['project', 'add', 'demo', '/demo'], captureIo(client))).toBe(0);
    expect(bodies).toMatchObject([{ allow_network: true }, { allow_network: false }]);
  });

  it('attention open/answer pass question and options verbatim', async () => {
    const calls: unknown[] = [];
    const client = fakeClient({
      openAttention: async (b) => {
        calls.push(b);
        return attention;
      },
      answerAttention: async (id, b) => {
        calls.push([id, b]);
        return { ...attention, status: 'answered', answer: 'A', answered_via: 'cli' };
      },
    });
    const io = captureIo(client);
    await runCli(
      [
        'attention',
        'open',
        '--question',
        '要哪個？',
        '--option',
        'A',
        '--option',
        'B',
        '--task',
        't_000001',
      ],
      io,
    );
    await runCli(['attention', 'answer', 'a_000001', 'A'], io);
    expect(calls).toEqual([
      { question: '要哪個？', options: ['A', 'B'], task_id: 't_000001' },
      ['a_000001', { answer: 'A', via: 'cli' }],
    ]);
    expect(io.out[1]).toBe('a_000001 [decision/answered] 要哪個？ [A / B] → A\n');
  });

  it('task queue|cancel|retry and reassign call the matching action', async () => {
    const seen: string[] = [];
    const client = fakeClient({
      taskAction: async (id, action) => {
        seen.push(`${action} ${id}`);
        return task;
      },
      reassignTask: async (id, role) => {
        seen.push(`reassign ${id} ${role}`);
        return task;
      },
      roles: async () => [
        {
          name: 'impl_B',
          description: null,
          model_alias: 'gpt-sol',
          runner: 'codex',
          slots: 3,
          enabled: true,
          fallback: [],
        },
      ],
    });
    for (const argv of [['queue'], ['cancel'], ['retry'], ['reassign']]) {
      const extra = argv[0] === 'reassign' ? ['impl_B'] : [];
      expect(await runCli(['task', ...argv, 't_000001', ...extra], captureIo(client))).toBe(0);
    }
    expect(seen).toEqual([
      'queue t_000001',
      'cancel t_000001',
      'retry t_000001',
      'reassign t_000001 impl_B',
    ]);
  });

  it('serve runs the server and returns its exit code; the entry defaults to apps/server/dist', async () => {
    expect(await runCli(['serve'], captureIo(fakeClient({}), { serve: async () => 3 }))).toBe(3);
    expect(serverEntry({})).toMatch(/apps\/server\/dist\/main\.js$/);
    expect(serverEntry({ AGENT_TEAM_SERVER_ENTRY: '/x/main.js' })).toBe('/x/main.js');
  });
});

describe('team — output and exit codes', () => {
  it('--json prints the data; plain text is short', async () => {
    const client = fakeClient({ listTasks: async () => [task] });
    const json = captureIo(client);
    expect(await runCli(['--json', 'task', 'list'], json)).toBe(0);
    expect(JSON.parse(json.text())).toEqual([task]);
    const plain = captureIo(client);
    await runCli(['task', 'list'], plain);
    expect(plain.text()).toBe('t_000001 [draft] C impl_C 加一個功能\n');
  });

  it('business errors exit 1, connection/auth errors exit 2, with { code, message, hint }', async () => {
    const conflict = new TeamApiError(
      { code: 'conflict', message: 'task is done', hint: 'retry?' },
      409,
    );
    const io = captureIo(fakeClient({ taskAction: async () => Promise.reject(conflict) }));
    expect(await runCli(['task', 'cancel', 't_000001'], io)).toBe(1);
    expect(io.err.join('')).toBe('error: task is done\nhint: retry?\n');

    const down = new TeamApiError(
      { code: 'unavailable', message: 'not running', hint: 'team serve' },
      0,
    );
    const offline = captureIo(async () => Promise.reject(down));
    expect(await runCli(['--json', 'status'], offline)).toBe(2);
    expect(JSON.parse(offline.text())).toEqual({
      error: { code: 'unavailable', message: 'not running', hint: 'team serve' },
    });
  });

  it('receipt prints the latest receipt or fails with 1', async () => {
    const detail = {
      task,
      workspace: null,
      attention: [],
      runs: [
        {
          id: 'r_000002',
          kind: 'review',
          role: 'review_C',
          model_alias: 'gpt-sol',
          receipt: {
            dispatch_id: 'd_1',
            verdict: 'needs_changes',
            summary: '少了錯誤處理',
            findings: [{ file: 'src/a.ts', line: 3, severity: 'must_fix', issue: '未處理 null' }],
          },
        },
      ],
    } as unknown as TaskDetail;
    const io = captureIo(fakeClient({ getTask: async () => detail }));
    expect(await runCli(['receipt', 't_000001'], io)).toBe(0);
    expect(io.text()).toBe(
      'r_000002 review review_C gpt-sol: needs_changes\n  少了錯誤處理\n  must_fix src/a.ts:3 未處理 null\n',
    );
    const none = captureIo(fakeClient({ getTask: async () => ({ ...detail, runs: [] }) }));
    expect(await runCli(['receipt', 't_000001'], none)).toBe(1);
  });

  it('leader reset starts a new conversation', async () => {
    let calls = 0;
    const io = captureIo(
      fakeClient({
        resetLeader: async () => {
          calls += 1;
          return {
            session_id: '00000000-0000-4000-8000-000000000001',
            leader: { state: 'idle', last_activity_at: null, available: true },
          };
        },
      }),
    );
    expect(await runCli(['leader', 'reset'], io)).toBe(0);
    expect(calls).toBe(1);
    expect(io.text()).toBe('new leader session 00000000-0000-4000-8000-000000000001 (idle)\n');
  });

  it('watch prints one line per event and passes --after', async () => {
    const event = {
      seq: 7,
      ts: T0,
      type: 'task.status_changed',
      task_id: 't_000001',
      run_id: null,
      data: { from: 'queued', to: 'running', reason: null },
    } as EventRecord;
    let after: number | undefined;
    const client = fakeClient({
      events: (options) => {
        after = options.after;
        options.onEvent(event);
        return { lastSeq: () => 7, close: () => {}, done: Promise.resolve() };
      },
    });
    const io = captureIo(client);
    expect(await runCli(['watch', '--after', '5'], io)).toBe(0);
    expect(after).toBe(5);
    expect(io.text()).toBe(`#7 ${T0} task.status_changed t_000001 queued→running\n`);
    expect(
      eventLine({
        ...event,
        type: 'project.created',
        task_id: null,
        data: { name: 'demo' },
      } as EventRecord),
    ).toBe(`#7 ${T0} project.created {"name":"demo"}`);
  });

  it('status and doctor summaries', async () => {
    const state = {
      last_seq: 3,
      generated_at: T0,
      projects: [project],
      tasks: [
        task,
        { ...task, id: 't_000002', status: 'running' },
        { ...task, id: 't_000003', status: 'cancelled' },
      ],
      active_runs: [],
      open_attention: [attention],
      runners: [
        { runner: 'claude', available: true, circuit: 'closed', cooldown_until: null },
        { runner: 'dsh', available: false, circuit: 'open', cooldown_until: null },
      ],
      leader: { state: 'offline', last_activity_at: null },
    } as unknown as Parameters<typeof formatStatus>[0];
    expect(formatStatus(state).split('\n')).toEqual([
      'tasks: pending 1 · in_progress 1 · review 0 · blocked 0 · done 0',
      '  t_000002 [running] C impl_C 加一個功能',
      'attention: 1 open',
      'runners: claude ok · dsh circuit open',
      'leader: offline',
    ]);
    const io = captureIo(
      fakeClient({
        doctor: async () => ({
          ok: false,
          checks: [{ name: 'env.OPENROUTER_API_KEY', ok: true, detail: 'absent (optional)' }],
          runners: [],
        }),
      }),
    );
    expect(await runCli(['doctor'], io)).toBe(1);
    expect(io.text()).toBe(
      'ok   env.OPENROUTER_API_KEY absent (optional)\ndoctor: problems found\n',
    );
  });

  it('help exits 0', async () => {
    const io = captureIo(fakeClient({}));
    expect(await runCli(['--help'], io)).toBe(0);
    expect(io.text()).toContain('Usage: team');
  });
});
