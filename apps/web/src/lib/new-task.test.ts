import { describe, expect, it } from 'vitest';
import { makeBoardTask, makeResearchBoardTask } from '../test/fixtures.js';
import {
  buildNewTaskRequest,
  buildTaskRequest,
  citableResearch,
  parseOwnedPaths,
  toggleRef,
  type NewTaskInput,
} from './new-task.js';

const input = (over: Partial<NewTaskInput> = {}): NewTaskInput => ({
  kind: 'impl',
  project_id: 'p_0123456789ab',
  title: ' 加入 a 功能 ',
  tier: 'C',
  owned_paths: 'src/a/\nsrc/b.ts, src/a/\n\n',
  ticket_md: '# 派工單',
  research_refs: [],
  question: '',
  queue: true,
  ...over,
});

describe('new task form', () => {
  it('splits owned paths by line or comma and drops duplicates', () => {
    expect(parseOwnedPaths('src/a/\nsrc/b.ts, src/a/\n ，docs/')).toEqual([
      'src/a/',
      'src/b.ts',
      'docs/',
    ]);
  });

  it('builds the request body the server expects', () => {
    const result = buildTaskRequest(input());
    expect(result).toEqual({
      ok: true,
      body: {
        project_id: 'p_0123456789ab',
        title: '加入 a 功能',
        tier: 'C',
        ticket_md: '# 派工單',
        owned_paths: ['src/a/', 'src/b.ts'],
        queue: true,
      },
    });
  });

  it('reports field errors from the shared schema', () => {
    const result = buildTaskRequest(
      input({ title: '', owned_paths: '/etc/passwd\n../x', ticket_md: '  ', project_id: '' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'owned_paths',
      'project_id',
      'ticket_md',
      'title',
    ]);
  });

  it('sends research_refs only when citing', () => {
    const result = buildTaskRequest(input({ research_refs: ['t_r1', 't_r2'] }));
    expect(result.ok && result.body.research_refs).toEqual(['t_r1', 't_r2']);
    const four = buildTaskRequest(input({ research_refs: ['t_r1', 't_r2', 't_r3', 't_r4'] }));
    expect(four).toMatchObject({ ok: false, errors: { research_refs: '參考調研最多 3 個' } });
  });
});

describe('new research task (spec §17)', () => {
  it('builds the POST /research body: question, no tier or paths', () => {
    const result = buildNewTaskRequest(
      input({ kind: 'research', question: '  有哪些 CRDT 函式庫？ ', owned_paths: '' }),
    );
    expect(result).toEqual({
      ok: true,
      request: {
        kind: 'research',
        body: {
          project_id: 'p_0123456789ab',
          title: '加入 a 功能',
          question: '有哪些 CRDT 函式庫？',
          queue: true,
        },
      },
    });
  });

  it('requires a question and a project', () => {
    const result = buildNewTaskRequest(input({ kind: 'research', question: ' ', project_id: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['project_id', 'question']);
  });

  it('lists only done research tasks of the project as citable', () => {
    const tasks = [
      makeResearchBoardTask({ id: 't_r1', status: 'done', updated_at: '2026-11-20T09:00:00.000Z' }),
      makeResearchBoardTask({ id: 't_r2', status: 'done', updated_at: '2026-11-20T10:00:00.000Z' }),
      makeResearchBoardTask({ id: 't_r3', status: 'running' }),
      makeResearchBoardTask({ id: 't_r4', status: 'done', project_id: 'p_other' }),
      makeBoardTask({ id: 't_i1', status: 'done' }),
    ];
    expect(citableResearch(tasks, 'p_demo').map((t) => t.id)).toEqual(['t_r2', 't_r1']);
  });

  it('caps the checked refs at 3', () => {
    expect(toggleRef(['a', 'b', 'c'], 'd', true)).toEqual(['a', 'b', 'c']);
    expect(toggleRef(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
    expect(toggleRef(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
    expect(toggleRef(['a'], 'a', true)).toEqual(['a']);
  });
});
