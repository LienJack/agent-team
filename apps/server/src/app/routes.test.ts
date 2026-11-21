import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editing } from '@agent-team/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestService,
  local,
  TEST_TOKEN,
  type Loose,
  type TestService,
} from '../testing/harness.js';

let h: TestService;
let app: ReturnType<TestService['localApp']>;

beforeEach(() => {
  h = createTestService();
  app = h.localApp();
});
afterEach(async () => {
  await h.cleanup();
});

async function call(path: string, body?: unknown) {
  const res = await app.request(path, local(body));
  return { status: res.status, body: (await res.json()) as Loose };
}

const project = {
  name: 'demo',
  repo_path: '/repos/demo',
  checks: [{ name: 'test', cmd: 'pnpm test' }],
};

async function newProject() {
  return (await call('/api/projects', project)).body['project'] as { id: string };
}

async function newTask(projectId: string, extra: Record<string, unknown> = {}) {
  const task = {
    project_id: projectId,
    title: '加一個功能',
    tier: 'C',
    ticket_md: '# 派工單',
    owned_paths: ['src/feature/'],
    ...extra,
  };
  return (await call('/api/tasks', task)).body['task'] as { id: string; status: string };
}

describe('§14 server — routes (happy path and validation failure)', () => {
  it('GET /api/state returns the board snapshot with last_seq', async () => {
    await newProject();
    const { status, body } = await call('/api/state');
    expect(status).toBe(200);
    expect(body).toMatchObject({ last_seq: 1, leader: { state: 'offline' } });
    expect(body['projects']).toHaveLength(1);
    expect(body['runners'].map((r: { runner: string }) => r.runner).sort()).toEqual([
      'claude',
      'codex',
      'dsh',
    ]);
  });

  it('projects: list, create (201), duplicate name 409, invalid body 400', async () => {
    expect((await call('/api/projects')).body).toEqual({ projects: [] });
    const created = await call('/api/projects', project);
    expect(created.status).toBe(201);
    expect(created.body['project']).toMatchObject({ name: 'demo', base_branch: 'main' });
    expect((await call('/api/projects', project)).body['error'].code).toBe('conflict');
    const bad = await call('/api/projects', { name: 'Bad Name', repo_path: 'relative' });
    expect(bad.status).toBe(400);
    expect(bad.body['error']).toMatchObject({ code: 'validation_failed' });
  });

  it('tasks: create, list with filters, detail, 404, invalid', async () => {
    const p = await newProject();
    const t = await newTask(p.id);
    expect(t.status).toBe('draft');
    const list = await call(`/api/tasks?project_id=${p.id}&status=draft,queued`);
    expect(list.body['tasks'].map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect((await call('/api/tasks?status=running')).body['tasks']).toEqual([]);
    expect((await call('/api/tasks?status=bogus')).status).toBe(400);
    const detail = await call(`/api/tasks/${t.id}`);
    expect(detail.body).toMatchObject({
      task: { id: t.id },
      runs: [],
      workspace: null,
      attention: [],
    });
    expect((await call('/api/tasks/t_999999')).status).toBe(404);
    expect((await call('/api/tasks/not-an-id')).status).toBe(400);
    const bad = await call('/api/tasks', { project_id: p.id, title: '', tier: 'Z' });
    expect(bad.body['error'].code).toBe('validation_failed');
    const missing = await newTaskStatus({ project_id: 'p_999999' });
    expect(missing).toBe(404);
  });

  async function newTaskStatus(extra: Record<string, unknown>) {
    const res = await call('/api/tasks', {
      title: 't',
      tier: 'C',
      ticket_md: 'x',
      owned_paths: ['a'],
      ...extra,
    });
    return res.status;
  }

  it('task actions: queue → runs to review, approve → done; cancel, retry, reassign, reject', async () => {
    const p = await newProject();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    h.runners.codex.script({ hold: true }); // review waits
    const t = await newTask(p.id);
    expect((await call(`/api/tasks/${t.id}/queue`, {})).body['task'].status).toBe('queued');
    await h.service.engine.drain();
    expect(h.store.tasks.get(t.id)!.status).toBe('review');
    const approved = await call(`/api/tasks/${t.id}/approve`, { reason: 'looks good' });
    expect(approved.body['task'].status).toBe('done');
    expect((await call(`/api/tasks/${t.id}/cancel`, {})).body['error'].code).toBe('conflict');

    const t2 = await newTask(p.id);
    expect(
      (await call(`/api/tasks/${t2.id}/reassign`, { role: 'impl_B' })).body['task'],
    ).toMatchObject({
      impl_role: 'impl_B',
    });
    expect((await call(`/api/tasks/${t2.id}/reassign`, { role: 'Bad Role' })).status).toBe(400);
    expect((await call(`/api/tasks/${t2.id}/retry`, {})).body['error'].code).toBe('conflict');
    expect((await call(`/api/tasks/${t2.id}/reject`, { note: 'x' })).body['error'].code).toBe(
      'conflict',
    );
    expect((await call(`/api/tasks/${t2.id}/reject`, { note: '' })).status).toBe(400);
    const cancelled = await call(`/api/tasks/${t2.id}/cancel`, { reason: 'not needed' });
    expect(cancelled.body['task'].status).toBe('cancelled');
  });

  it('a body-less action is accepted (the body is optional)', async () => {
    const p = await newProject();
    const t = await newTask(p.id);
    const res = await app.request(`/api/tasks/${t.id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('attention: open (201), list by status, answer, answer twice 409, invalid via', async () => {
    const opened = await call('/api/attention', { question: '要哪個？', options: ['A', 'B'] });
    expect(opened.status).toBe(201);
    const id = opened.body['attention'].id as string;
    expect((await call('/api/attention?status=open')).body['attention']).toHaveLength(1);
    expect((await call('/api/attention?status=nope')).status).toBe(400);
    const answered = await call(`/api/attention/${id}/answer`, { answer: 'A', via: 'cli' });
    expect(answered.body['attention']).toMatchObject({ status: 'answered', answered_via: 'cli' });
    expect((await call(`/api/attention/${id}/answer`, { answer: 'B', via: 'cli' })).status).toBe(
      409,
    );
    expect((await call(`/api/attention/${id}/answer`, { answer: 'B', via: 'fax' })).status).toBe(
      400,
    );
    expect((await call('/api/attention', { question: '' })).status).toBe(400);
  });

  it('runs: log tail of events.jsonl; unknown run 404; bad tail 400', async () => {
    const p = await newProject();
    h.runners.dsh.script(editing(h.git, ['src/feature/a.ts']));
    const t = await newTask(p.id, { queue: true });
    await h.service.engine.runUntilIdle();
    const run = h.store.runs.list({ task_id: t.id })[0]!;
    mkdirSync(run.log_dir, { recursive: true });
    writeFileSync(join(run.log_dir, 'events.jsonl'), '{"a":1}\n{"a":2}\n{"a":3}\n');
    const log = await call(`/api/runs/${run.id}/log?tail=2`);
    expect(log.body).toEqual({ run_id: run.id, lines: ['{"a":2}', '{"a":3}'], truncated: true });
    expect((await call('/api/runs/r_999999/log')).status).toBe(404);
    expect((await call(`/api/runs/${run.id}/log?tail=0`)).status).toBe(400);
  });

  it('leader: message stored and deduplicated, reply not_implemented (501); list', async () => {
    const msg = { text: '你好', source: 'cli', client_msg_id: 'c-1' };
    const first = await call('/api/leader/messages', msg);
    expect(first.status).toBe(501);
    expect(first.body['error']).toMatchObject({ code: 'not_implemented' });
    expect(first.body['error'].message).toMatch(/^not_implemented/);
    await call('/api/leader/messages', msg);
    const list = await call('/api/leader/messages');
    expect(list.body['messages']).toHaveLength(1);
    expect(list.body['messages'][0]).toMatchObject({ body: '你好', client_msg_id: 'c-1' });
    expect((await call('/api/leader/messages?after=1')).body['messages']).toEqual([]);
    expect((await call('/api/leader/messages', { text: '', source: 'cli' })).status).toBe(400);
  });

  it('resume, quota and doctor', async () => {
    const resume = await call('/api/resume');
    expect(resume.body['summary_md']).toContain('# 現況摘要');
    const quota = await call('/api/quota');
    expect(quota.body['runners']).toHaveLength(3);
    const doctor = await call('/api/doctor');
    expect(doctor.status).toBe(200);
    const env = doctor.body['checks'].filter((c: { name: string }) => c.name.startsWith('env.'));
    expect(env.find((c: { name: string }) => c.name === 'env.TEAM_LAN_PASSWORD')).toEqual({
      name: 'env.TEAM_LAN_PASSWORD',
      ok: true,
      detail: 'present (optional)',
    });
    expect(JSON.stringify(doctor.body)).not.toContain('correct horse');
    expect(doctor.body['runners']).toHaveLength(3);
  });

  it('unknown routes and malformed JSON use the error envelope', async () => {
    const missing = await call('/api/nope');
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    const res = await app.request('/api/attention', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
  });
});
