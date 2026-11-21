import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReceipt } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFirstJsonObject } from '../json.js';
import { parseJsonLine } from '../process/lines.js';
import type { ChildResult } from '../process/spawn.js';
import { REDACTED } from '../redact.js';
import { fixtureLines, fixtureText, makeSpec, tempDir } from '../test-support.js';
import { lastRecord, writeScenario, type FakeCliResponse } from '../testing/index.js';
import { DSH_PATCH_FILE, dshPatch } from './args.js';
import { DshRunner } from './runner.js';
import { DshStream } from './stream.js';

const exited = (code: number): ChildResult => ({
  reason: 'exit',
  exitCode: code,
  signal: null,
  durationMs: 1,
});

function parse(name: string, code = 0, stderrTail: string[] = []) {
  const p = new DshStream();
  for (const raw of fixtureLines(import.meta.url, name)) p.line(parseJsonLine(raw));
  return p.finish({ child: exited(code), stderrTail });
}

describe('runners: dsh stream parsing', () => {
  it('takes the first complete JSON object of final.text and sums step usage', () => {
    const r = parse('success.jsonl');
    expect(r.error).toBeUndefined();
    expect(parseReceipt('impl', r.final)).toMatchObject({ ok: true });
    expect(r.sessionRef).toBe('session-00000000-0000-4000-8000-000000000002');
    expect(r.usage).toEqual({
      input_tokens: 2500,
      output_tokens: 140,
      cache_read_tokens: 2200,
      reasoning_tokens: 25,
    });
  });

  it('maps turn_end MISSING_CREDENTIAL (recorded from a real run) to auth', () => {
    const r = parse('missing-credential.jsonl', 1);
    expect(r.error?.kind).toBe('auth');
    expect(r.error?.message).toMatch(/^dsh MISSING_CREDENTIAL: /);
  });

  it('reports bad_output when the final text has no JSON object', () => {
    expect(parse('no-json.jsonl').error?.kind).toBe('bad_output');
  });

  it('reports a driver error event (no final) as a crash with its message', () => {
    const r = parse('driver-error.jsonl', 1);
    expect(r.error?.kind).toBe('crash');
    expect(r.error?.message).toContain('unknown session id');
  });

  it('extracts JSON objects robustly', () => {
    expect(extractFirstJsonObject('x {"a":"}{"} y {"b":1}')).toEqual({ a: '}{' });
    expect(extractFirstJsonObject('{bad} then {"ok":true}')).toEqual({ ok: true });
    expect(extractFirstJsonObject('{"open": ')).toBeUndefined();
    expect(extractFirstJsonObject('[1,2]')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ argv via the scripted CLI

const probe: FakeCliResponse[] = [
  { argv: ['--version'], stdout: '0.2.1-rc.5' },
  { argv: ['--help'], stdout: fixtureText(import.meta.url, 'help.txt') },
  {
    argv: ['--profile', 'headless', '--help'],
    stdout: fixtureText(import.meta.url, 'headless-help.txt'),
  },
];

// assembled at runtime: no key-like literal in the source
const KEY = ['sk', 'or', 'v1', 'f'.repeat(48)].join('-');

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

describe('runners: dsh argv', () => {
  it('runs headless with the generated patch, the key only in the child env, and redacts it', async () => {
    const spec = makeSpec(tmp.dir, {
      model: 'deepseek/deepseek-v4.1-flash',
      dispatchId: 'd_fixture0002',
    });
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: [
        { err: `debug: using key ${KEY}` },
        ...fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
      ],
    });
    const runner = new DshRunner({
      env: (name) => (name === 'OPENROUTER_API_KEY' ? KEY : undefined),
      command: s.command,
      sourceEnv: { ...process.env, OPENROUTER_API_KEY: 'from-service-env', GIT_WORK_TREE: '/x' },
    });
    const r = await runner.run(spec, new AbortController().signal);
    expect(r.error).toBeUndefined();

    const rec = lastRecord(s.recordPath)!;
    const patchPath = join(spec.logDir, DSH_PATCH_FILE);
    expect(rec.argv).toEqual(['--profile', 'headless', '--patch', patchPath, '--json', '-']);
    expect(rec).toMatchObject({ stdin: spec.prompt, stdinClosed: true });
    expect(rec.envNames).toEqual(
      expect.arrayContaining([
        'OPENROUTER_API_KEY',
        'DSH_TELEMETRY_DISABLED',
        'DSH_PERMISSION_MODE',
      ]),
    );
    expect(rec.envNames).not.toContain('GIT_WORK_TREE');
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('model: "deepseek/deepseek-v4.1-flash"');
    expect(patch).toContain('provider: "openrouter"');
    expect(patch).toContain('mode: "workspace-write"');
    expect(patch).not.toContain(KEY);
    const stderr = readFileSync(join(spec.logDir, 'stderr.log'), 'utf8');
    expect(stderr).toContain(REDACTED);
    expect(stderr).not.toContain(KEY);
  });

  it('uses a read-only sandbox for review runs and --session-id for resume', async () => {
    const spec = makeSpec(tmp.dir, { writable: false, resumeRef: 'session-abc' });
    expect(dshPatch(spec)).toContain('mode: "read-only"');
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(import.meta.url, 'no-json.jsonl').map((out) => ({ out })),
    });
    const runner = new DshRunner({ env: () => KEY, command: s.command });
    const r = await runner.run(spec, new AbortController().signal);
    expect(r.error?.kind).toBe('bad_output');
    expect(lastRecord(s.recordPath)!.argv).toEqual([
      '--profile',
      'headless',
      '--patch',
      join(spec.logDir, DSH_PATCH_FILE),
      '--json',
      '--session-id',
      'session-abc',
      '-',
    ]);
  });

  it('fails with auth before spawning when the key is missing', async () => {
    const s = await writeScenario(tmp.dir, { responses: probe });
    const runner = new DshRunner({ env: () => undefined, command: s.command });
    const r = await runner.run(makeSpec(tmp.dir), new AbortController().signal);
    expect(r.error?.kind).toBe('auth');
    const caps = await runner.probe();
    expect(caps).toMatchObject({ available: false, credentials: 'missing' });
    expect(caps.flags).toEqual(['--json', '--patch', '--profile', '--session-id']);
  });

  it('reports a missing binary as unavailable', async () => {
    const runner = new DshRunner({ env: () => KEY, sourceEnv: { PATH: join(tmp.dir, 'nothing') } });
    expect(await runner.probe()).toMatchObject({
      available: false,
      problems: ['dsh executable not found on PATH'],
    });
  });
});
