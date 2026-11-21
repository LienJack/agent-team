import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReceipt } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventually, fixtureLines, makeSpec, tempDir } from '../test-support.js';
import { lastRecord, processAlive, writeScenario, type FakeCliResponse } from '../testing/index.js';
import { resolveBundledCodex } from './binary.js';
import { CODEX_EXEC_FLAGS, CODEX_ISOLATION_FLAGS, CodexRunner } from './runner.js';
import { CodexStream } from './stream.js';

function parse(name: string) {
  const s = new CodexStream();
  for (const raw of fixtureLines(import.meta.url, name)) s.event(JSON.parse(raw));
  return s.finish();
}

describe('runners: codex stream parsing', () => {
  it('takes the last agent_message as the final and maps turn.completed usage', () => {
    const r = parse('success.jsonl');
    expect(r.error).toBeUndefined();
    expect(parseReceipt('review', r.final)).toMatchObject({ ok: true });
    expect(r.sessionRef).toBe('00000000-0000-4000-8000-000000000003');
    expect(r.usage).toEqual({
      input_tokens: 3000,
      output_tokens: 420,
      cache_read_tokens: 12000,
      cache_write_tokens: 0,
      reasoning_tokens: 128,
    });
  });

  it('maps a usage limit to rate_limit with a reset time', () => {
    const r = parse('usage-limit.jsonl');
    expect(r.error?.kind).toBe('rate_limit');
    expect(r.quota?.exhausted).toBe(true);
    expect(Date.parse(r.quota!.resetsAt!) - Date.now()).toBeGreaterThan(2 * 3600_000);
  });

  it('maps 401 to auth and a non-JSON final to bad_output', () => {
    expect(parse('unauthorized.jsonl').error?.kind).toBe('auth');
    expect(parse('no-json.jsonl').error?.kind).toBe('bad_output');
  });
});

describe('runners: codex bundled binary', () => {
  it('resolves the binary shipped with the pinned SDK', () => {
    const bin = resolveBundledCodex();
    expect(existsSync(bin.executable)).toBe(true);
    expect(bin.executable).toContain('@openai');
  });
});

// ------------------------------------------- through the real SDK, the group wrapper and the fake CLI

const probeWith = (flags: readonly string[]): FakeCliResponse[] => [
  { argv: ['--version'], stdout: 'codex-cli 0.171.0' },
  {
    argv: ['exec', '--help'],
    stdout: [...flags, '--json'].map((f) => `  ${f} <x>`).join('\n'),
  },
  { argv: ['login', 'status'], stdout: 'Logged in using ChatGPT' },
];
const probe = probeWith([...CODEX_EXEC_FLAGS, ...CODEX_ISOLATION_FLAGS]);

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

describe('runners: codex argv', () => {
  it('starts codex exec through the SDK with the spec options and stdin closed', async () => {
    const spec = makeSpec(tmp.dir, {
      model: 'gpt-6.1-terra',
      effort: 'low',
      writable: false,
      dispatchId: 'd_fixture0003',
    });
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
    });
    const runner = new CodexRunner({
      command: s.command,
      sourceEnv: { ...process.env, OPENAI_API_KEY: 'x', GIT_DIR: '/x', CLAUDECODE: '1' },
    });
    const started: unknown[] = [];
    const r = await runner.run(spec, new AbortController().signal, {
      onStarted: (i) => started.push(i),
    });
    expect(r.error).toBeUndefined();
    expect(parseReceipt('review', r.final)).toMatchObject({ ok: true });
    expect(started).toEqual([
      { sessionRef: '00000000-0000-4000-8000-000000000003', pid: expect.any(Number) },
    ]);

    const rec = lastRecord(s.recordPath)!;
    const schemaAt = rec.argv.indexOf('--output-schema');
    expect(schemaAt).toBeGreaterThan(0);
    const expected = [
      'exec',
      // inserted by the group wrapper: no user config.toml / execpolicy rules (docs/adr/0011)
      '--ignore-user-config',
      '--ignore-rules',
      '--experimental-json',
      '--config',
      'skills.include_instructions=false',
      '--model',
      'gpt-6.1-terra',
      '--sandbox',
      'read-only',
      '--cd',
      spec.cwd,
      '--skip-git-repo-check',
      '--output-schema',
      rec.argv[schemaAt + 1]!,
      '--config',
      'model_reasoning_effort="low"',
      '--config',
      'approval_policy="never"',
    ];
    expect(rec.argv).toEqual(expected);
    expect(rec).toMatchObject({ stdin: spec.prompt, stdinClosed: true });
    for (const name of [
      'OPENAI_API_KEY',
      'GIT_DIR',
      'CLAUDECODE',
      'AGENT_TEAM_REAL_CMD',
      'AGENT_TEAM_PGID_FILE',
    ]) {
      expect(rec.envNames).not.toContain(name);
    }
    expect(readFileSync(join(spec.logDir, 'events.jsonl'), 'utf8')).toContain('"turn.completed"');
  });

  it('does not pass isolation flags the CLI does not list, and says so', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probeWith(CODEX_EXEC_FLAGS),
      steps: fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
    });
    const runner = new CodexRunner({ command: s.command });
    const caps = await runner.probe();
    expect(caps.available).toBe(true);
    expect(caps.problems).toEqual([
      "optional codex exec flag --ignore-user-config not supported; the user's config/rules apply",
      "optional codex exec flag --ignore-rules not supported; the user's config/rules apply",
    ]);
    await runner.run(
      makeSpec(tmp.dir, { model: 'gpt-6.1-terra', dispatchId: 'd_fixture0003', writable: false }),
      new AbortController().signal,
    );
    const argv = lastRecord(s.recordPath)!.argv;
    expect(argv.slice(0, 2)).toEqual(['exec', '--experimental-json']);
    for (const f of CODEX_ISOLATION_FLAGS) expect(argv).not.toContain(f);
  });

  it('uses workspace-write for writable runs', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(import.meta.url, 'no-json.jsonl').map((out) => ({ out })),
    });
    const r = await new CodexRunner({ command: s.command }).run(
      makeSpec(tmp.dir, { model: 'gpt-6.1-terra' }),
      new AbortController().signal,
    );
    expect(r.error?.kind).toBe('bad_output');
    const argv = lastRecord(s.recordPath)!.argv;
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it('kills the whole codex process group on timeout', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: [
        { out: fixtureLines(import.meta.url, 'success.jsonl')[0]! },
        { spawnChild: true },
        { hang: true },
      ],
    });
    const runner = new CodexRunner({ command: s.command, killGraceMs: 500 });
    const r = await runner.run(
      makeSpec(tmp.dir, { model: 'gpt-6.1-terra', timeoutMs: 1500 }),
      new AbortController().signal,
    );
    expect(r.error?.kind).toBe('timeout');
    expect(r.sessionRef).toBe('00000000-0000-4000-8000-000000000003');
    const rec = lastRecord(s.recordPath)!;
    expect(rec.children).toHaveLength(1);
    expect(await eventually(() => !processAlive(rec.pid) && !processAlive(rec.children[0]!))).toBe(
      true,
    );
  });

  it('cancels on abort and kills the group', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: [
        { out: fixtureLines(import.meta.url, 'success.jsonl')[0]! },
        { spawnChild: true },
        { hang: true },
      ],
    });
    const ac = new AbortController();
    const runner = new CodexRunner({ command: s.command, killGraceMs: 500 });
    const pending = runner.run(makeSpec(tmp.dir, { model: 'gpt-6.1-terra' }), ac.signal, {
      onStarted: () => setTimeout(() => ac.abort(), 200),
    });
    const r = await pending;
    expect(r.error?.kind).toBe('cancelled');
    const rec = lastRecord(s.recordPath)!;
    expect(
      await eventually(() => !processAlive(rec.pid) && rec.children.every((c) => !processAlive(c))),
    ).toBe(true);
  });

  it('honours an abort that arrives while the run is being prepared', async () => {
    const s = await writeScenario(tmp.dir, { responses: probe, steps: [{ hang: true }] });
    const ac = new AbortController();
    const pending = new CodexRunner({ command: s.command, killGraceMs: 300 }).run(
      makeSpec(tmp.dir, { model: 'gpt-6.1-terra' }),
      ac.signal,
    );
    ac.abort();
    expect((await pending).error?.kind).toBe('cancelled');
  });

  it('maps a failing exec (exit 1 + stderr) through the SDK error', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: [{ err: 'Error: 401 Unauthorized, please run codex login' }, { exit: 1 }],
    });
    const r = await new CodexRunner({ command: s.command }).run(
      makeSpec(tmp.dir, { model: 'gpt-6.1-terra' }),
      new AbortController().signal,
    );
    expect(r.error?.kind).toBe('auth');
  });
});
