import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRedactor, REDACTED, redactSecrets } from '../redact.js';
import { eventually, tempDir } from '../test-support.js';
import { lastRecord, processAlive, writeScenario, type FakeScenario } from '../testing/index.js';
import { childEnv } from './env.js';
import { LineSplitter, parseJsonLine } from './lines.js';
import { RunLog } from './run-log.js';
import { runChild } from './spawn.js';

let tmp: ReturnType<typeof tempDir>;
let work: string;

beforeEach(() => {
  tmp = tempDir();
  work = join(tmp.dir, 'work');
  mkdirSync(work);
});
afterEach(() => tmp.cleanup());

async function fake(scenario: FakeScenario) {
  return writeScenario(tmp.dir, scenario);
}

function run(command: string[], extra: Partial<Parameters<typeof runChild>[0]> = {}) {
  const lines: string[] = [];
  const promise = runChild({
    command: command[0]!,
    args: command.slice(1),
    cwd: work,
    env: childEnv(),
    timeoutMs: 10_000,
    killGraceMs: 300,
    onStdoutLine: (l) => {
      lines.push(l);
    },
    ...extra,
  });
  return { promise, lines };
}

describe('runners: child processes', () => {
  it('closes stdin after writing the prompt, and closes it immediately without one', async () => {
    const s = await fake({ steps: [{ out: 'ok' }] });
    const withInput = await run(s.command, { stdin: 'hello prompt' }).promise;
    expect(withInput.reason).toBe('exit');
    expect(lastRecord(s.recordPath)).toMatchObject({ stdin: 'hello prompt', stdinClosed: true });
    await run(s.command).promise;
    expect(lastRecord(s.recordPath)).toMatchObject({ stdin: '', stdinClosed: true });
  });

  it('kills the whole process group on timeout (no orphan left)', async () => {
    const s = await fake({ steps: [{ spawnChild: true }, { out: 'started' }, { hang: true }] });
    const res = await run(s.command, { timeoutMs: 800 }).promise;
    expect(res.reason).toBe('timeout');
    const rec = lastRecord(s.recordPath)!;
    expect(rec.children).toHaveLength(1);
    expect(await eventually(() => !processAlive(rec.pid) && !processAlive(rec.children[0]!))).toBe(
      true,
    );
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const s = await fake({ ignoreSigterm: true, steps: [{ hang: true }] });
    const started = Date.now();
    const res = await run(s.command, { timeoutMs: 500, killGraceMs: 300 }).promise;
    expect(res.reason).toBe('timeout');
    expect(res.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(processAlive(lastRecord(s.recordPath)!.pid)).toBe(false);
  });

  it('kills the group on abort', async () => {
    const s = await fake({ steps: [{ spawnChild: true }, { hang: true }] });
    const ac = new AbortController();
    const { promise } = run(s.command, { signal: ac.signal });
    await eventually(() => (lastRecord(s.recordPath)?.children.length ?? 0) > 0);
    ac.abort();
    const res = await promise;
    expect(res.reason).toBe('aborted');
    const rec = lastRecord(s.recordPath)!;
    expect(await eventually(() => !processAlive(rec.pid) && !processAlive(rec.children[0]!))).toBe(
      true,
    );
  });

  it('completes on the agent end signal even if the process lingers', async () => {
    const s = await fake({ steps: [{ out: 'a' }, { out: 'END' }, { hang: true }] });
    const res = await run(s.command, {
      endGraceMs: 100,
      onStdoutLine: (l) => (l === 'END' ? 'end' : undefined),
    }).promise;
    expect(res.reason).toBe('end_signal');
    expect(res.durationMs).toBeLessThan(5000);
    expect(processAlive(lastRecord(s.recordPath)!.pid)).toBe(false);
  });

  it('cleans up background survivors after a normal exit', async () => {
    const s = await fake({ steps: [{ spawnChild: true }, { exit: 0 }] });
    const res = await run(s.command).promise;
    expect(res).toMatchObject({ reason: 'exit', exitCode: 0 });
    const child = lastRecord(s.recordPath)!.children[0]!;
    expect(await eventually(() => !processAlive(child))).toBe(true);
  });

  it('reports a missing executable as spawn_error', async () => {
    const res = await run([join(tmp.dir, 'no-such-binary')]).promise;
    expect(res.reason).toBe('spawn_error');
    expect(res.spawnError?.code).toBe('ENOENT');
  });

  it('builds child environments from the allow-list only', () => {
    const env = childEnv(
      ['CLAUDE_CONFIG_DIR'],
      { EXTRA: '1' },
      {
        PATH: '/bin',
        HOME: '/h',
        CLAUDECODE: '1',
        ANTHROPIC_BASE_URL: 'http://proxy',
        GIT_DIR: '/x',
        OPENROUTER_API_KEY: 'k',
        CLAUDE_CONFIG_DIR: '/c',
      },
    );
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_CONFIG_DIR',
      'EXTRA',
      'HOME',
      'NO_COLOR',
      'PATH',
    ]);
  });
});

describe('runners: line reader', () => {
  it('splits chunks into lines, keeps split multi-byte characters, flushes the tail', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('{"a":"中文"}\r\nsecond', 'utf8');
    s.push(bytes.subarray(0, 8));
    s.push(bytes.subarray(8));
    s.end();
    expect(lines).toEqual(['{"a":"中文"}', 'second']);
    expect(parseJsonLine(lines[0]!)).toEqual({ a: '中文' });
    expect(parseJsonLine('not json')).toBeUndefined();
    expect(parseJsonLine('[1]')).toBeUndefined();
  });
});

describe('runners: log redaction', () => {
  // key-like test values are assembled at runtime so no literal key sits in the source
  const orKey = ['sk', 'or', 'v1', 'a'.repeat(40)].join('-');
  const ghToken = `${'gh'}p_${'b'.repeat(36)}`;
  const literal = `plain${'Z'.repeat(20)}`;

  it('masks key-like strings and known literals', () => {
    const text = `key=${orKey} token ${ghToken} Authorization: Bearer ${'c'.repeat(30)} API_KEY=hunter2hunter2 ${literal}`;
    const out = redactSecrets(text, [literal]);
    for (const secret of [orKey, ghToken, 'c'.repeat(30), 'hunter2hunter2', literal]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(REDACTED);
    expect(redactSecrets('nothing secret here: d_123 t_456')).toBe(
      'nothing secret here: d_123 t_456',
    );
  });

  it('redacts events.jsonl, stderr.log and prompt.md before writing', async () => {
    const dir = join(tmp.dir, 'runs', 'r_1');
    const log = await RunLog.open(dir, makeRedactor([literal]));
    await log.writePrompt(`prompt with ${orKey}`);
    log.event(`{"type":"x","text":"${orKey}"}`);
    log.stderrLine(`error: ${literal}`);
    await log.close();
    for (const f of ['events.jsonl', 'stderr.log', 'prompt.md']) {
      const content = readFileSync(join(dir, f), 'utf8');
      expect(content).toContain(REDACTED);
      expect(content).not.toContain(orKey);
      expect(content).not.toContain(literal);
    }
  });
});
