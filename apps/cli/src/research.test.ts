import { TeamApiError, type Project, type ResearchDetail, type Task } from '@agent-team/client';
import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

// spec §17 entrances: `team research add|show`, `team task add … --research <id>`.

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
const research: Task = {
  id: 't_000009',
  project_id: 'p_000001',
  parent_id: null,
  kind: 'research',
  title: '調研：佇列',
  tier: 'C',
  ticket_md: '有哪些 SQLite 佇列？',
  owned_paths: [],
  research_refs: [],
  priority: 0,
  status: 'queued',
  impl_role: 'oss_researcher',
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

describe('§17 team research', () => {
  it('add: project by name, --question, --queue; prints the task with its kind', async () => {
    let body: unknown;
    const client = fakeClient({
      listProjects: async () => [project],
      createResearch: async (b) => {
        body = b;
        return research;
      },
    });
    const io = captureIo(client);
    const argv = [
      'research',
      'add',
      'demo',
      '--title',
      '調研：佇列',
      '--question',
      'Q?',
      '--queue',
    ];
    expect(await runCli(argv, io)).toBe(0);
    expect(body).toEqual({
      project_id: 'p_000001',
      title: '調研：佇列',
      question: 'Q?',
      queue: true,
    });
    expect(io.text()).toBe('t_000009 [queued] research oss_researcher 調研：佇列\n');
  });

  it('add: the question comes from exactly one of --question, --question-file and -', async () => {
    const questions: string[] = [];
    const client = fakeClient({
      createResearch: async (b) => {
        questions.push(b.question);
        return research;
      },
    });
    const io = (extra = {}) =>
      captureIo(client, {
        readStdin: async () => 'from stdin',
        readFile: async (p) => `from ${p}`,
        ...extra,
      });
    expect(await runCli(['research', 'add', 'p_000001', '--title', 't', '-'], io())).toBe(0);
    expect(
      await runCli(
        ['research', 'add', 'p_000001', '--title', 't', '--question-file', 'q.md'],
        io(),
      ),
    ).toBe(0);
    expect(questions).toEqual(['from stdin', 'from /work/q.md']);
    for (const argv of [
      ['research', 'add', 'p_000001', '--title', 't'],
      ['research', 'add', 'p_000001', '--title', 't', '--question', 'q', '-'],
      ['research', 'add', 'p_000001', '--title', 't', '--question', ' '],
    ]) {
      const capture = io();
      expect(await runCli(argv, capture)).toBe(2);
      expect(capture.err.join('')).toMatch(/question/);
    }
  });

  it('add under the leader seed sends a derived Idempotency-Key; 409 when research is off', async () => {
    const keys: Array<string | undefined> = [];
    const client = fakeClient({
      createResearch: async (_b, options) => {
        keys.push(options?.idempotencyKey);
        throw new TeamApiError(
          { code: 'conflict', message: 'the research stage is off', hint: 'set research.mode' },
          409,
        );
      },
    });
    const io = captureIo(client, { env: { AGENT_TEAM_IDEMPOTENCY_SEED: 'leader:msg:m_1' } });
    const code = await runCli(
      ['research', 'add', 'p_000001', '--title', 't', '--question', 'q'],
      io,
    );
    expect(code).toBe(1);
    expect(keys[0]).toMatch(/^leader:msg:m_1:[0-9a-f]{32}$/);
    expect(io.err.join('')).toContain('the research stage is off');
  });

  it('show: recommendation and candidates, marked as not verified', async () => {
    const detail: ResearchDetail = {
      task: { ...research, status: 'done' },
      run_id: 'r_000002',
      receipt: {
        dispatch_id: 'd_000002',
        status: 'done',
        summary: '兩個候選',
        recommendation: 'adapt_pattern',
        needs_leader: '',
        candidates: [
          {
            name: 'litequeue',
            url: 'https://example.com/litequeue',
            license: 'MIT',
            fit: 'high',
            borrow: '租約設計',
            caveats: '',
          },
        ],
      },
    };
    const io = captureIo(fakeClient({ getResearch: async () => detail }));
    expect(await runCli(['research', 'show', 't_000009'], io)).toBe(0);
    const text = io.text();
    expect(text).toContain('done · recommendation adapt_pattern (run r_000002)');
    expect(text).toContain('candidates (links not verified by the service):');
    expect(text).toContain('1. litequeue https://example.com/litequeue [MIT, fit high]');
    expect(text).toContain('borrow: 租約設計');
  });

  it('task add --research (repeatable) sends research_refs', async () => {
    let body: Record<string, unknown> = {};
    const client = fakeClient({
      createTask: async (b) => {
        body = b as Record<string, unknown>;
        return { ...research, kind: 'impl', research_refs: ['t_1', 't_2'] };
      },
    });
    const argv = ['task', 'add', '--project', 'p_000001', '--title', 't', '--tier', 'C'];
    argv.push('--paths', 'src/', '--research', 't_1', '--research', 't_2', '-');
    expect(await runCli(argv, captureIo(client, { readStdin: async () => '# x' }))).toBe(0);
    expect(body['research_refs']).toEqual(['t_1', 't_2']);
    // without --research the field is left out
    const plain = argv.filter((a, i) => a !== '--research' && argv[i - 1] !== '--research');
    expect(await runCli(plain, captureIo(client, { readStdin: async () => '# x' }))).toBe(0);
    expect(body).not.toHaveProperty('research_refs');
  });
});
