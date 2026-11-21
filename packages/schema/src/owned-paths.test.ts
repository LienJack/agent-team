import { describe, expect, it } from 'vitest';
import { LeaderMessageRequestSchema, TaskCreateRequestSchema } from './api/dto.js';
import { ownedPathProblem } from './domain.js';

describe('schema: owned path spellings (M7)', () => {
  it.each(['.', './', 'src', 'src/', './src/a', 'src/**/*.ts', 'docs/x.md', 'a/b/c/'])(
    'accepts %s',
    (p) => expect(ownedPathProblem(p)).toBeNull(),
  );

  it.each([
    ['', 'empty'],
    ['/etc', 'absolute'],
    ['C:/x', 'absolute'],
    ['../x', '..'],
    ['src/../../x', '..'],
    ['src//a', 'empty segments'],
    ['src/./a', '"." segments'],
    ['src\\a', 'backslashes'],
    [' src', 'whitespace'],
    ['src//', 'empty segments'],
  ])('refuses %j (%s)', (p, why) => {
    expect(ownedPathProblem(p)).toContain(why);
  });

  it('applies the rules in the task request', () => {
    const base = { project_id: 'p_0000000000000', title: 't', tier: 'C', ticket_md: 'x' };
    expect(TaskCreateRequestSchema.safeParse({ ...base, owned_paths: ['.'] }).success).toBe(true);
    expect(TaskCreateRequestSchema.safeParse({ ...base, owned_paths: ['a//b'] }).success).toBe(
      false,
    );
  });
});

describe('schema: reserved client_msg_id prefixes (L9b)', () => {
  it.each(['reply:m_abc', 'events:1-2', 'm_0123456789ab'])('refuses %s', (id) => {
    const r = LeaderMessageRequestSchema.safeParse({ text: 'hi', client_msg_id: id });
    expect(r.success).toBe(false);
  });

  it('accepts a client uuid and needs no source', () => {
    const r = LeaderMessageRequestSchema.safeParse({
      text: 'hi',
      client_msg_id: '2b1c3a4e-0000-4000-8000-000000000000',
    });
    expect(r.success).toBe(true);
  });
});
