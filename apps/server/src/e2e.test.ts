import { readFileSync } from 'node:fs';
import type { EventRecord, ReviewReceipt, RunSpec } from '@agent-team/schema';
import { reviewReceipt } from '@agent-team/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestService, type Loose, type TestService } from './testing/harness.js';

// End-to-end over real HTTP on an ephemeral loopback port (spec §14 端到端), fake runners.

let h: TestService | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

interface Api {
  get(path: string): Promise<Loose>;
  post(path: string, body: unknown): Promise<Loose>;
  events(after: number, until: (e: EventRecord) => boolean): Promise<EventRecord[]>;
}

async function startApi(t: TestService): Promise<Api> {
  const running = await t.service.start();
  const { addr, token } = JSON.parse(readFileSync(running.listenerFile, 'utf8')) as {
    addr: string;
    token: string;
  };
  const headers = { authorization: `Bearer ${token}` };
  const send = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${addr}${path}`, init);
    const body = (await res.json()) as Loose;
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  return {
    get: (path) => send(path, { headers }),
    post: (path, body) =>
      send(path, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': `${path}:${Math.random()}`,
        },
        body: JSON.stringify(body),
      }),
    // read the SSE stream until `until` matches (or 10 s pass)
    events: async (after, until) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${addr}/api/events?after=${after}`, {
        headers,
        signal: controller.signal,
      });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      const out: EventRecord[] = [];
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!data) continue;
            const parsed = JSON.parse(data) as EventRecord | { type: 'server.connected' };
            if (parsed.type === 'server.connected') continue;
            out.push(parsed as EventRecord);
            if (until(parsed as EventRecord)) return out;
          }
        }
        return out;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}

const statusChanges = (events: EventRecord[], taskId: string) =>
  events
    .filter((e) => e.task_id === taskId && e.type === 'task.status_changed')
    .map((e) => (e.data as { to: string }).to);

const isDone = (taskId: string) => (e: EventRecord) =>
  e.task_id === taskId &&
  e.type === 'task.status_changed' &&
  (e.data as { to: string }).to === 'done';

/** The delivery a task command reply may carry for the status it reports (docs/adr/0022). */
const DELIVERY_FOR: Record<string, string[]> = {
  queued: ['queued'],
  running: ['running', 'queued'],
  verifying: ['running'],
  review: ['running', 'queued'],
  done: ['done'],
};

describe('§14 端到端 — fake runners over real HTTP', () => {
  it('(a) create project → queue task → done with a service-side commit', async () => {
    h = createTestService();
    const t = h;
    let edits = 0;
    t.runners.dsh.defaultStep = {
      onRun: (spec: RunSpec) => {
        if (spec.writable) t.git.touch(spec.cwd, [`src/feature/f${++edits}.ts`]);
      },
    };
    const api = await startApi(t);
    const { project } = await api.post('/api/projects', {
      name: 'demo',
      repo_path: '/repos/demo',
      checks: [{ name: 'test', cmd: 'pnpm test' }],
    });
    const { task } = await api.post('/api/tasks', {
      project_id: project.id,
      title: '加入 a 功能',
      tier: 'C',
      ticket_md: '# 派工單\n做 a',
      owned_paths: ['src/feature/'],
    });
    const start = (await api.get('/api/state')).last_seq as number;
    const [queued, events] = await Promise.all([
      api.post(`/api/tasks/${task.id}/queue`, {}),
      api.events(start, isDone(task.id)),
    ]);
    // one scheduling pass ran before the reply: the fast fake worker may already have it
    expect(DELIVERY_FOR[queued.task.status]).toContain(queued.delivery.state);
    expect(queued.report).toContain(task.id);

    expect(statusChanges(events, task.id)).toEqual([
      'queued',
      'running',
      'verifying',
      'review',
      'done',
    ]);
    const commit = events.find((e) => e.type === 'commit.created');
    expect(commit?.data).toMatchObject({ message: `team(${task.id}): 加入 a 功能` });
    const flow = events.filter((e) => e.task_id === task.id).map((e) => e.type);
    for (const type of [
      'run.created',
      'run.dispatched',
      'run.verified',
      'commit.created',
      'review.completed',
    ]) {
      expect(flow).toContain(type);
    }

    // the SSE subscriber went away with the aborted connection
    for (let i = 0; i < 50 && t.service.events.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(t.service.events.size).toBe(0);

    const detail = await api.get(`/api/tasks/${task.id}`);
    expect(detail.task.status).toBe('done');
    expect(detail.workspace.head_sha).toBe((commit!.data as { sha: string }).sha);
    expect(
      detail.runs.map((r: { kind: string; outcome: string }) => `${r.kind}:${r.outcome}`),
    ).toEqual(['impl:ok', 'review:ok']);
    expect(t.checks.calls.map((c) => c.name)).toEqual(['test']);
  });

  it('(b) human reject → fix → model rejects → escalate impl_C → impl_B → done', async () => {
    h = createTestService();
    const t = h;
    let edits = 0;
    const edit = (spec: RunSpec) => {
      if (spec.writable) t.git.touch(spec.cwd, [`src/feature/f${++edits}.ts`]);
    };
    const needsChanges = (spec: RunSpec): { final: ReviewReceipt } => ({
      final: reviewReceipt(spec, {
        verdict: 'needs_changes',
        summary: '缺少錯誤處理',
        findings: [
          { file: 'src/feature/f1.ts', line: 3, severity: 'must_fix', issue: '未處理 null' },
        ],
      }),
    });
    // impl_C = deepseek-flash (dsh); review_C = gpt-sol (codex), or kimi-pro (dsh) when the
    // implementer was gpt-sol (impl_B after escalation)
    t.runners.dsh.defaultStep = { onRun: edit };
    let codexReviews = 0;
    t.runners.codex.defaultStep = { onRun: edit };
    t.runners.codex.script({ hold: true }); // first review waits for the human
    const api = await startApi(t);
    const { project } = await api.post('/api/projects', { name: 'demo', repo_path: '/repos/demo' });
    const { task } = await api.post('/api/tasks', {
      project_id: project.id,
      title: '修正登入',
      tier: 'C',
      ticket_md: '# 派工單',
      owned_paths: ['src/feature/'],
      queue: true,
    });
    const reviewHeld = await api.events(
      0,
      (e) =>
        e.task_id === task.id && e.type === 'run.dispatched' && t.runners.codex.held().length > 0,
    );
    expect(reviewHeld.length).toBeGreaterThan(0);
    t.runners.codex.defaultStep = {
      onRun: edit,
      result: (spec) => {
        if (spec.writable) {
          return {
            final: {
              dispatch_id: spec.dispatchId,
              status: 'done',
              summary: 'ok',
              files_changed: [],
              checks: [],
              needs_leader: '',
            },
          };
        }
        codexReviews += 1;
        return needsChanges(spec);
      },
    };
    const before = (await api.get('/api/state')).last_seq as number;
    const [rejected, events] = await Promise.all([
      api.post(`/api/tasks/${task.id}/reject`, { note: '請補上錯誤處理' }),
      api.events(before, isDone(task.id)),
    ]);
    expect(DELIVERY_FOR[rejected.task.status]).toContain(rejected.delivery.state);

    const escalated = events.find((e) => e.type === 'task.escalated');
    expect(escalated?.data).toEqual({ from_role: 'impl_C', to_role: 'impl_B', fix_rounds: 2 });
    const detail = await api.get(`/api/tasks/${task.id}`);
    expect(detail.task).toMatchObject({ status: 'done', impl_role: 'impl_B' });
    const runs = detail.runs.map((r: Loose) => `${r.kind}:${r.role}:${r.model_alias}:${r.outcome}`);
    expect(runs).toEqual([
      'impl:impl_C:deepseek-flash:ok',
      'review:review_C:gpt-sol:cancelled',
      'fix:impl_C:deepseek-flash:ok',
      'review:review_C:gpt-sol:ok',
      'fix:impl_C:deepseek-flash:ok',
      'review:review_C:gpt-sol:ok',
      'fix:impl_B:gpt-sol:ok',
      'review:review_C:kimi-pro:ok',
    ]);
    expect(codexReviews).toBe(2);
    const flow = events
      .filter(
        (e) =>
          e.task_id === task.id &&
          ['task.status_changed', 'task.escalated', 'review.completed'].includes(e.type),
      )
      .map((e) =>
        e.type === 'task.status_changed' ? `→${(e.data as { to: string }).to}` : e.type,
      );
    const round = ['→queued', '→running', '→verifying', '→review', 'review.completed'];
    expect(flow).toEqual([...round, ...round, 'task.escalated', ...round, '→done']);
  });
});
