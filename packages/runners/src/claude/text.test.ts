import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv } from '../process/env.js';
import { fixtureLines, tempDir } from '../test-support.js';
import { lastRecord, writeScenario, type FakeCliStep } from '../testing/index.js';
import { probeClaudeCli, runClaudeText } from './text.js';

// One plain-text `claude -p` call (the leader's turns), driven by the scripted fake CLI with
// streams recorded from Claude Code 2.1.326 (`leader-turn.jsonl`: Bash allow-listed to `team`,
// three commands refused; `compact.jsonl`: `/compact` on a resumed session).

let t: ReturnType<typeof tempDir>;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const fromFixture = (name: string): FakeCliStep[] =>
  fixtureLines(import.meta.url, name).map((line) => ({ out: line }));

async function run(steps: FakeCliStep[], extra: Partial<Parameters<typeof runClaudeText>[0]> = {}) {
  const s = await writeScenario(t.dir, { steps });
  const [command, ...prefix] = s.command;
  const result = await runClaudeText({
    command: command!,
    args: [...prefix, '-p', '--output-format', 'stream-json', '--verbose'],
    cwd: t.dir,
    env: childEnv(),
    prompt: '[訊息｜來源 cli｜m_000001]\n列出任務',
    timeoutMs: 10_000,
    logDir: join(t.dir, 'log'),
    ...extra,
  });
  return { result, record: lastRecord(s.recordPath)! };
}

describe('runners: claude text calls', () => {
  it('reads text, session, summed usage, last-call context size, quota, commands and denials', async () => {
    const { result, record } = await run(fromFixture('leader-turn.jsonl'));
    expect(result.error).toBeUndefined();
    expect(result.started).toBe(true);
    expect(result.sessionRef).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.text).toMatch(/^1\. ran/);
    expect(result.commands).toEqual([
      'team status',
      'ls /',
      'team status; echo INJECTED',
      'echo hi',
      'team status && cat /etc/hosts',
      'team task list $(whoami)',
    ]);
    expect(result.denied).toEqual([
      'ls /',
      'team status && cat /etc/hosts',
      'team task list $(whoami)',
    ]);
    // result.usage sums every model call; the context is the last call's size
    expect(result.usage).toMatchObject({ cache_read_tokens: 45133, output_tokens: 938 });
    expect(result.contextTokens).toBe(2 + 7757 + 336 + 1);
    expect(result.quota).toMatchObject({ utilization: 0.28, exhausted: false });
    expect(record.stdin).toBe('[訊息｜來源 cli｜m_000001]\n列出任務');
    expect(record.stdinClosed).toBe(true);
    expect(readFileSync(join(t.dir, 'log', 'events.jsonl'), 'utf8')).toContain('"type": "result"');
  });

  it('reports a /compact turn with the context size after compaction', async () => {
    const { result } = await run(fromFixture('compact.jsonl'));
    expect(result.error).toBeUndefined();
    expect(result.compacted).toEqual({ preTokens: 8311, postTokens: 1444 });
    expect(result.contextTokens).toBe(1444);
    expect(result.text).toBe('');
  });

  it('classifies rate limits (with the reset time), auth and crashes', async () => {
    const limited = await run(fromFixture('rate-limited.jsonl'));
    expect(limited.result.error?.kind).toBe('rate_limit');
    expect(limited.result.quota).toMatchObject({
      exhausted: true,
      resetsAt: new Date(1763701200 * 1000).toISOString(),
    });
    expect((await run(fromFixture('not-logged-in.jsonl'))).result.error?.kind).toBe('auth');
    const crash = await run([{ err: 'Error: boom' }, { exit: 3 }]);
    expect(crash.result.error).toEqual({
      kind: 'crash',
      message: 'claude exited with code 3: Error: boom',
    });
    expect(crash.result.started).toBe(false);
  });

  it('refuses permission-skipping flags without spawning, and times out a hung call', async () => {
    const s = await writeScenario(t.dir, { steps: [{ hang: true }] });
    const refused = await runClaudeText({
      command: s.command[0]!,
      args: [...s.command.slice(1), '--dangerously-skip-permissions'],
      cwd: t.dir,
      env: childEnv(),
      prompt: 'x',
      timeoutMs: 5000,
    });
    expect(refused.error?.message).toMatch(/refusing to pass --dangerously-skip-permissions/);
    expect(existsSync(s.recordPath)).toBe(false);
    const hung = await run([{ hang: true }], { timeoutMs: 300 });
    expect(hung.result.error?.kind).toBe('timeout');
  });

  it('probes version, wanted flags and the login state', async () => {
    const help = '  -p, --print\n  --model <m>\n  --resume [v]\n  --allowed-tools <t...>\n';
    const s = await writeScenario(t.dir, {
      responses: [
        { argv: ['--version'], stdout: '2.1.326 (Claude Code)' },
        { argv: ['--help'], stdout: help },
        { argv: ['auth', 'status', '--json'], stdout: '{"loggedIn":false,"email":"x@y"}' },
      ],
    });
    const probe = await probeClaudeCli({
      command: s.command,
      env: childEnv(),
      cwd: t.dir,
      wanted: ['--print', '--model', '--resume', '--allowedTools', '--restricted'],
      required: ['--print', '--model', '--session-id'],
    });
    expect(probe).toMatchObject({
      available: false,
      version: '2.1.326 (Claude Code)',
      loggedIn: false,
      problems: ['required flag --session-id not supported'],
    });
    expect([...probe.flags].sort()).toEqual(['--allowedTools', '--model', '--print', '--resume']);
  });
});
