import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from '@agent-team/core';
import { createTestEngine } from '@agent-team/core/testing';
import type { RunStartedInfo } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeRunner } from './claude/runner.js';
import { CODEX_EXEC_FLAGS, CODEX_ISOLATION_FLAGS, CodexRunner } from './codex/runner.js';
import { DshRunner } from './dsh/runner.js';
import { fakeKeys, fixtureLines, fixtureText, makeSpec, tempDir } from './test-support.js';
import {
  readRecords,
  writeScenario,
  type FakeCliResponse,
  type FakeCliStep,
} from './testing/index.js';

// docs/adr/0010: `start_unknown` = the child was spawned (codex: the SDK call was made) but it
// ended before the first agent event, without proof that nothing ran. Every runner reports it;
// the engine never resends it and asks a human.

const fixtures = (runner: string) => new URL(`./${runner}/runner.ts`, import.meta.url).href;

interface Kind {
  name: 'claude' | 'codex' | 'dsh';
  probe: FakeCliResponse[];
  /** The runner's first agent event (recorded fixture line). */
  first: string;
  make(command: string[]): Runner;
  model: string;
}

const KINDS: Kind[] = [
  {
    name: 'claude',
    probe: [
      { argv: ['--version'], stdout: '2.1.326 (Claude Code)' },
      { argv: ['--help'], stdout: fixtureText(fixtures('claude'), 'help.txt') },
      { argv: ['auth', 'status', '--json'], stdout: JSON.stringify({ loggedIn: true }) },
    ],
    first: fixtureLines(fixtures('claude'), 'success.jsonl')[0]!,
    make: (command) => new ClaudeRunner({ command }),
    model: 'claude-haiku-5-5',
  },
  {
    name: 'codex',
    probe: [
      { argv: ['--version'], stdout: 'codex-cli 0.171.0' },
      {
        argv: ['exec', '--help'],
        stdout: [...CODEX_EXEC_FLAGS, ...CODEX_ISOLATION_FLAGS, '--json']
          .map((f) => `  ${f} <x>`)
          .join('\n'),
      },
      { argv: ['login', 'status'], stdout: 'Logged in using ChatGPT' },
    ],
    first: fixtureLines(fixtures('codex'), 'success.jsonl')[0]!,
    make: (command) => new CodexRunner({ command, killGraceMs: 300 }),
    model: 'gpt-6.1-terra',
  },
  {
    name: 'dsh',
    probe: [
      { argv: ['--version'], stdout: '0.2.1-rc.5' },
      { argv: ['--help'], stdout: fixtureText(fixtures('dsh'), 'help.txt') },
      {
        argv: ['--profile', 'headless', '--help'],
        stdout: fixtureText(fixtures('dsh'), 'headless-help.txt'),
      },
    ],
    first: fixtureLines(fixtures('dsh'), 'success.jsonl')[0]!,
    make: (command) => new DshRunner({ keys: fakeKeys().broker, command, allowUnsandboxed: true }),
    model: 'deepseek/deepseek-v4.1-flash',
  },
];

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

async function run(kind: Kind, steps: FakeCliStep[], timeoutMs = 20_000) {
  const s = await writeScenario(tmp.dir, { responses: kind.probe, steps }, kind.name);
  const started: RunStartedInfo[] = [];
  const result = await kind
    .make(s.command)
    .run(makeSpec(tmp.dir, { model: kind.model, timeoutMs }), new AbortController().signal, {
      onStarted: (i) => started.push(i),
    });
  return { result, started, records: readRecords(s.recordPath) };
}

describe.each(KINDS)('runners: $name start_unknown', (kind) => {
  it('a process that dies before its first agent event → start_unknown, onStarted never called', async () => {
    const { result, started } = await run(kind, [{ err: 'something odd' }, { crash: 'SIGKILL' }]);
    expect(result.error?.kind).toBe('start_unknown');
    expect(result.error?.message).toMatch(/cannot tell whether work started/);
    expect(started).toEqual([]);
  });

  it('a silent exit (code 1, unrecognised output) before the first event → start_unknown', async () => {
    const { result, started } = await run(kind, [{ err: 'segfault-ish noise' }, { exit: 1 }]);
    expect(result.error?.kind).toBe('start_unknown');
    expect(started).toEqual([]);
  });

  it('hanging without any agent event until the timeout → start_unknown', async () => {
    const { result, started } = await run(kind, [{ hang: true }], 1500);
    expect(result.error?.kind).toBe('start_unknown');
    expect(result.error?.message).toMatch(/no agent event within 1500 ms/);
    expect(started).toEqual([]);
  });

  it('an explicit refusal before starting stays a normal error (auth, usage) — safe to resend', async () => {
    const auth = await run(kind, [{ err: 'Error: 401 Unauthorized, not logged in' }, { exit: 1 }]);
    expect(auth.result.error?.kind).toBe('auth');
    const usage = await run(kind, [
      { err: "error: unexpected argument '--nope' found" },
      { exit: 2 },
    ]);
    expect(usage.result.error?.kind).toBe('crash');
    expect([...auth.started, ...usage.started]).toEqual([]);
  });

  it('after the first agent event a crash is a crash, and onStarted fired once with pid and session', async () => {
    const { result, started } = await run(kind, [{ out: kind.first }, { crash: 'SIGKILL' }]);
    expect(result.error?.kind).toBe('crash');
    expect(started).toHaveLength(1);
    // the pid's OS start time rides along once `ps` answered (docs/adr/0015)
    expect(started[0]).toMatchObject({ pid: expect.any(Number), sessionRef: expect.any(String) });
    expect(Object.keys(started[0] as object).sort()).toEqual(
      expect.arrayContaining(['pid', 'sessionRef']),
    );
  });
});

describe('engine + real runners: start_unknown is never resent (spec §8)', () => {
  const roles = { claude: 'impl_A', codex: 'impl_B', dsh: 'impl_C' } as const;

  it.each(KINDS)(
    '$name: run start_unknown, task blocked, one attention item, one spawn',
    async (kind) => {
      const s = await writeScenario(
        tmp.dir,
        { responses: kind.probe, steps: [{ crash: 'SIGKILL' }] },
        `${kind.name}-engine`,
      );
      const h = createTestEngine({
        config: { worktreeRoot: join(tmp.dir, 'wt'), dataDir: join(tmp.dir, 'data') },
      });
      h.registry.register(kind.make(s.command));
      const task = h.task({ impl_role: roles[kind.name], tier: 'B' });
      // the fake git does not create directories; the runner needs a real cwd
      const ws = join(tmp.dir, 'wt', 'demo', task.id);
      mkdirSync(ws, { recursive: true });
      await h.engine.runUntilIdle();

      const runs = h.store.runs.list({ task_id: task.id });
      expect(runs.map((r) => [r.runner, r.state])).toEqual([[kind.name, 'start_unknown']]);
      expect(h.get(task.id).status).toBe('blocked');
      const open = h.store.attention.list({ task_id: task.id, statuses: ['open'] });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ kind: 'decision', options: ['重試', '取消'] });
      const dispatched = h.store.events
        .listAfter(0)
        .filter((e) => e.type === 'run.dispatched')
        .map((e) => (e.data as { outcome: string }).outcome);
      expect(dispatched).toEqual(['unknown']);

      h.clock.advance(3600_000);
      await h.engine.runUntilIdle();
      const spawns = readRecords(s.recordPath).filter((r) => r.stdin.length > 0);
      expect(spawns).toHaveLength(1);
      expect(h.store.runs.list({ task_id: task.id })).toHaveLength(1);
    },
  );
});
