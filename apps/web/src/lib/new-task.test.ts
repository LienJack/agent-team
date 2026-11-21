import { describe, expect, it } from 'vitest';
import { buildTaskRequest, parseOwnedPaths, type NewTaskInput } from './new-task.js';

const input = (over: Partial<NewTaskInput> = {}): NewTaskInput => ({
  project_id: 'p_0123456789ab',
  title: ' 加入 a 功能 ',
  tier: 'C',
  owned_paths: 'src/a/\nsrc/b.ts, src/a/\n\n',
  ticket_md: '# 派工單',
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
});
