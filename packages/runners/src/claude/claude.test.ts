import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReceipt } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonLine } from '../process/lines.js';
import type { ChildResult } from '../process/spawn.js';
import { fixtureLines, fixtureText, makeSpec, tempDir } from '../test-support.js';
import { lastRecord, readRecords, writeScenario, type FakeCliResponse } from '../testing/index.js';
import { claudeArgs, PERMISSION_BYPASS_FLAGS } from './args.js';
import { ClaudeRunner } from './runner.js';
import { ClaudeStream, parseClaudeRateLimit } from './stream.js';

const exit0: ChildResult = { reason: 'exit', exitCode: 0, signal: null, durationMs: 1 };

function parse(name: string, child: ChildResult = exit0) {
  const p = new ClaudeStream();
  for (const raw of fixtureLines(import.meta.url, name)) p.line(parseJsonLine(raw));
  return p.finish({ child, stderrTail: [] });
}

describe('runners: claude stream parsing', () => {
  it('takes structured_output, usage, cost, session and quota from a successful run', () => {
    const r = parse('success.jsonl');
    expect(r.error).toBeUndefined();
    expect(parseReceipt('impl', r.final).ok).toBe(true);
    expect(r.usage).toEqual({
      input_tokens: 12,
      output_tokens: 321,
      cache_read_tokens: 7890,
      cache_write_tokens: 3456,
    });
    expect(r.costUsd).toBe(0.0123);
    expect(r.sessionRef).toBe('00000000-0000-4000-8000-000000000001');
    // rate_limit_info shape recorded from a real Claude Code 2.1.326 run
    expect(r.quota).toEqual({
      utilization: 0.24,
      resetsAt: new Date(1795716000 * 1000).toISOString(),
      exhausted: false,
    });
  });

  it('maps "Not logged in" to an auth error', () => {
    expect(parse('not-logged-in.jsonl').error?.kind).toBe('auth');
  });

  it('maps a usage limit to rate_limit with an exhausted quota and its reset time', () => {
    const r = parse('rate-limited.jsonl');
    expect(r.error?.kind).toBe('rate_limit');
    expect(r.quota).toMatchObject({ exhausted: true, utilization: 1 });
    expect(r.quota?.resetsAt).toBe(new Date(1763701200 * 1000).toISOString());
  });

  it('reports bad_output when the result holds no JSON object', () => {
    expect(parse('no-json.jsonl').error?.kind).toBe('bad_output');
  });

  it('reports a crash when the process dies without a result', () => {
    const p = new ClaudeStream();
    const r = p.finish({ child: { ...exit0, exitCode: 1 }, stderrTail: ['boom'] });
    expect(r.error).toEqual({ kind: 'crash', message: 'claude exited with code 1: boom' });
  });

  it('reads both rate-limit shapes and clamps utilization', () => {
    expect(
      parseClaudeRateLimit({
        status: 'allowed_warning',
        utilization: 1.7,
        resetsAt: '2026-11-21T05:00:00Z',
      }),
    ).toEqual({ utilization: 1, resetsAt: '2026-11-21T05:00:00.000Z', exhausted: true });
    expect(
      parseClaudeRateLimit({
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.4, resetsAt: 1795700000, status: 'rejected' },
          seven_day: { utilization: 0.9, resetsAt: 1795716000, status: 'allowed' },
        },
      }),
    ).toEqual({
      utilization: 1,
      resetsAt: new Date(1795700000 * 1000).toISOString(),
      exhausted: true,
    });
    expect(parseClaudeRateLimit('nope')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ argv via the scripted CLI

const HELP = fixtureText(import.meta.url, 'help.txt');

function probeResponses(help = HELP, loggedIn = true): FakeCliResponse[] {
  return [
    { argv: ['--version'], stdout: '2.1.326 (Claude Code)' },
    { argv: ['--help'], stdout: help },
    { argv: ['auth', 'status', '--json'], stdout: JSON.stringify({ loggedIn }) },
  ];
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

const hostileEnv = {
  ...process.env,
  CLAUDECODE: '1',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  GIT_DIR: '/nonexistent',
  OPENROUTER_API_KEY: 'not-for-claude',
};

describe('runners: claude argv', () => {
  it('passes exactly the spec flags for a writable run, prompt on stdin, nothing that skips permissions', async () => {
    const spec = makeSpec(tmp.dir, { effort: 'low' });
    const s = await writeScenario(tmp.dir, {
      responses: probeResponses(),
      steps: fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
    });
    const runner = new ClaudeRunner({ command: s.command, sourceEnv: hostileEnv });
    const started: unknown[] = [];
    const result = await runner.run(spec, new AbortController().signal, {
      onStarted: (i) => started.push(i),
    });
    expect(result.error).toBeUndefined();
    expect(started).toHaveLength(1);

    const rec = lastRecord(s.recordPath)!;
    expect(rec.argv).toEqual([
      '-p',
      '--model',
      'claude-haiku-5-5',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(spec.schema),
      '--safe-mode',
      '--restricted',
      '--settings',
      expect.stringContaining('"sandbox":{"enabled":true'),
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      'Read,Edit,Write,Glob,Grep,Bash',
      '--allowedTools',
      'Read,Edit,Write,Glob,Grep,Bash',
      '--effort',
      'low',
    ]);
    for (const f of PERMISSION_BYPASS_FLAGS) expect(rec.argv).not.toContain(f);
    expect(rec.argv).not.toContain('bypassPermissions');
    expect(rec).toMatchObject({
      stdin: spec.prompt,
      stdinClosed: true,
      cwd: expect.stringContaining('work'),
    });
    for (const name of ['CLAUDECODE', 'ANTHROPIC_BASE_URL', 'GIT_DIR', 'OPENROUTER_API_KEY']) {
      expect(rec.envNames).not.toContain(name);
    }
    // the raw stream and the prompt are logged
    const logDir = spec.logDir;
    expect(readFileSync(join(logDir, 'events.jsonl'), 'utf8')).toContain('"type":"result"');
    expect(readFileSync(join(logDir, 'prompt.md'), 'utf8')).toBe(spec.prompt);
  });

  it('gives review runs read-only tools and drops flags the CLI does not list', async () => {
    const help = HELP.split('\n')
      .filter((l) => !/--effort|--tools|--permission-prompts/.test(l))
      .join('\n');
    const spec = makeSpec(tmp.dir, {
      writable: false,
      effort: 'high',
      dispatchId: 'd_fixture0003',
    });
    const s = await writeScenario(tmp.dir, {
      responses: probeResponses(help),
      steps: fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
    });
    const runner = new ClaudeRunner({ command: s.command });
    const caps = await runner.probe();
    expect(caps.available).toBe(true);
    expect(caps.problems).toEqual(
      expect.arrayContaining(['optional flag --effort not supported; not passed']),
    );
    await runner.run(spec, new AbortController().signal);
    const argv = lastRecord(s.recordPath)!.argv;
    expect(argv.slice(argv.indexOf('--allowedTools'), argv.indexOf('--allowedTools') + 2)).toEqual([
      '--allowedTools',
      'Read,Glob,Grep',
    ]);
    for (const f of ['--effort', '--tools', '--permission-prompts']) expect(argv).not.toContain(f);
    // probe + run = 4 invocations, each with stdin closed
    expect(readRecords(s.recordPath).every((r) => r.stdinClosed)).toBe(true);
  });

  it('never spawns when aborted while the run is being prepared', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probeResponses(),
      steps: [{ hang: true }],
    });
    const runner = new ClaudeRunner({ command: s.command });
    await runner.probe();
    const ac = new AbortController();
    const started: unknown[] = [];
    const pending = runner.run(makeSpec(tmp.dir), ac.signal, { onStarted: (i) => started.push(i) });
    ac.abort();
    expect((await pending).error?.kind).toBe('cancelled');
    expect(started).toEqual([]);
    expect(readRecords(s.recordPath)).toHaveLength(3); // the probe calls only
  });

  it('survives a throwing onStarted hook', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probeResponses(),
      steps: fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
    });
    const r = await new ClaudeRunner({ command: s.command }).run(
      makeSpec(tmp.dir),
      new AbortController().signal,
      {
        onStarted: () => {
          throw new Error('hook failed');
        },
      },
    );
    expect(r.error).toBeUndefined();
  });

  it('refuses to assemble a permission bypass', () => {
    const spec = makeSpec(tmp.dir, { model: '--dangerously-skip-permissions' });
    expect(() =>
      claudeArgs(spec, new Set(['--settings', '--restricted']), { denyPaths: [] }),
    ).toThrow(/refusing/);
  });

  it('times out by killing the process group', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probeResponses(),
      steps: [
        { out: fixtureLines(import.meta.url, 'success.jsonl')[0]! },
        { spawnChild: true },
        { hang: true },
      ],
    });
    const runner = new ClaudeRunner({ command: s.command });
    const r = await runner.run(makeSpec(tmp.dir, { timeoutMs: 700 }), new AbortController().signal);
    expect(r.error?.kind).toBe('timeout');
    // partial fields survive: the session id from system/init
    expect(r.sessionRef).toBe('00000000-0000-4000-8000-000000000001');
  });
});

describe('runners: claude probe', () => {
  it('reports a missing binary as unavailable and never spawns', async () => {
    const runner = new ClaudeRunner({ sourceEnv: { PATH: join(tmp.dir, 'empty-bin') } });
    const caps = await runner.probe();
    expect(caps).toMatchObject({ runner: 'claude', available: false });
    expect(caps.problems[0]).toMatch(/not found/);
    const r = await runner.run(makeSpec(tmp.dir), new AbortController().signal);
    expect(r.error?.kind).toBe('crash');
  });

  it('marks a logged-out CLI unavailable with credentials missing', async () => {
    const s = await writeScenario(tmp.dir, { responses: probeResponses(HELP, false) });
    const caps = await new ClaudeRunner({ command: s.command }).probe();
    expect(caps).toMatchObject({
      available: false,
      credentials: 'missing',
      version: '2.1.326 (Claude Code)',
    });
    expect(caps.flags).toContain('--json-schema');
  });
});
