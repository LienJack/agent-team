import type { Project } from '@agent-team/client';
import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { captureIo, fakeClient } from './testing.js';

const project: Project = {
  id: 'p_000001',
  name: 'demo',
  repo_path: '/repos/demo',
  base_branch: 'main',
  checks: [],
  allow_network: false,
  created_at: '2026-11-21T00:00:00.000Z',
};

describe('team project update', () => {
  it('resolves the name and replaces the checks with the repeated --check list', async () => {
    const calls: Array<[string, unknown]> = [];
    const client = fakeClient({
      listProjects: async () => [project],
      updateProject: async (id, body) => {
        calls.push([id, body]);
        return { ...project, checks: body.checks };
      },
    });
    const io = captureIo(client);
    const code = await runCli(
      ['project', 'update', 'demo', '--check', 'test=uv run pytest -q', '--check', 'lint=ruff .'],
      io,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      [
        'p_000001',
        {
          checks: [
            { name: 'test', cmd: 'uv run pytest -q' },
            { name: 'lint', cmd: 'ruff .' },
          ],
        },
      ],
    ]);
    expect(io.text()).toBe(
      'p_000001 demo /repos/demo (main, 2 checks)\n  check test: uv run pytest -q\n  check lint: ruff .\n',
    );
  });

  it('--clear-checks sends an empty list; neither or both is a usage error', async () => {
    const bodies: unknown[] = [];
    const client = fakeClient({
      updateProject: async (_id, body) => {
        bodies.push(body);
        return { ...project, checks: body.checks };
      },
    });
    const clear = captureIo(client);
    expect(await runCli(['project', 'update', 'p_000001', '--clear-checks'], clear)).toBe(0);
    expect(bodies).toEqual([{ checks: [] }]);
    expect(clear.text()).toContain('checks: (none)');
    expect(await runCli(['project', 'update', 'p_000001'], captureIo(client))).toBe(2);
    const both = ['project', 'update', 'p_000001', '--clear-checks', '--check', 't=x'];
    expect(await runCli(both, captureIo(client))).toBe(2);
    expect(bodies).toHaveLength(1);
  });
});
