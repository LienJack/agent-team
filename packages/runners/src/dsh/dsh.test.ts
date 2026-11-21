import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReceipt } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFirstJsonObject, unwrapSchemaEcho } from '../json.js';
import { parseJsonLine } from '../process/lines.js';
import type { ChildResult } from '../process/spawn.js';
import { REDACTED } from '../redact.js';
import { fakeKeys, fixtureLines, fixtureText, makeSpec, tempDir } from '../test-support.js';
import {
  envDigest,
  lastRecord,
  readRecords,
  writeScenario,
  type FakeCliResponse,
} from '../testing/index.js';
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

  it('unwraps a receipt the model wrapped in the schema shape (recorded from a real run)', () => {
    // deepseek-v4.1-flash answered {"type":"object","properties":{…receipt…}} (2026-11-21)
    const r = parse('schema-echo.jsonl');
    expect(r.error).toBeUndefined();
    const parsed = parseReceipt('impl', r.final);
    expect(parsed).toMatchObject({ ok: true, receipt: { dispatch_id: 'd_fixture0003' } });
    expect(parsed).toMatchObject({ receipt: { status: 'blocked' } });
  });

  it('leaves objects that only look like a schema alone', () => {
    const schema = { type: 'object', properties: { dispatch_id: { type: 'string' } } };
    expect(unwrapSchemaEcho(schema)).toBe(schema);
    const both = { type: 'object', dispatch_id: 'd_1', properties: { dispatch_id: 'd_2' } };
    expect(unwrapSchemaEcho(both)).toBe(both);
    expect(unwrapSchemaEcho({ type: 'object', properties: { dispatch_id: 'd_3' } })).toEqual({
      dispatch_id: 'd_3',
    });
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
  it('runs headless with the generated patch; the child gets a run token, never the key (docs/adr/0020)', async () => {
    const spec = makeSpec(tmp.dir, {
      model: 'deepseek/deepseek-v4.1-flash',
      dispatchId: 'd_fixture0002',
    });
    const keys = fakeKeys();
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: [
        { err: `debug: using key ${keys.broker.open('peek')!.token}` },
        ...fixtureLines(import.meta.url, 'success.jsonl').map((out) => ({ out })),
      ],
    });
    keys.opened.length = 0;
    const runner = new DshRunner({
      keys: keys.broker,
      command: s.command,
      // dsh's own sandbox modes (the opt-in without Seatbelt); the wrapper: dsh-sandbox.test.ts
      allowUnsandboxed: true,
      sandboxAvailable: () => false,
      sourceEnv: {
        ...process.env,
        OPENROUTER_API_KEY: KEY,
        TEAM_LAN_PASSWORD: 'lan-password-value',
        GIT_WORK_TREE: '/x',
        NO_PROXY: 'corp.example',
        HTTPS_PROXY: 'http://proxy.corp.example:3128',
      },
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
    expect(rec.envNames).not.toContain('TEAM_LAN_PASSWORD');
    // one lease for the run, revoked when it ended; its token is the child's key
    expect(keys.opened).toEqual([
      { runId: 'd_fixture0002', token: expect.stringMatching(/^at-run-/), revoked: true },
    ]);
    const token = keys.opened[0]!.token;
    expect(rec.envDigests['OPENROUTER_API_KEY']).toBe(envDigest(token));
    expect(Object.values(rec.envDigests)).not.toContain(envDigest(KEY));
    // loopback never goes through an outer proxy
    expect(rec.envDigests['NO_PROXY']).toBe(envDigest('corp.example,127.0.0.1,localhost,::1'));
    expect(rec.envDigests['no_proxy']).toBe(envDigest('corp.example,127.0.0.1,localhost,::1'));
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('model: "deepseek/deepseek-v4.1-flash"');
    expect(patch).toContain('provider: "openrouter"');
    expect(patch).toContain('mode: "workspace-write"');
    expect(patch).toContain(
      `- id: llm-pi-ai\n  config:\n    providers:\n      openrouter:\n        apiKeyEnv: "OPENROUTER_API_KEY"\n        baseURL: "http://127.0.0.1:${keys.port}/api/v1"\n`,
    );
    expect(patch).not.toContain(KEY);
    expect(patch).not.toContain(token);
    const stderr = readFileSync(join(spec.logDir, 'stderr.log'), 'utf8');
    expect(stderr).toContain(REDACTED);
    expect(stderr).not.toContain('at-run-test');
  });

  it('uses a read-only sandbox for review runs and --session-id for resume', async () => {
    const spec = makeSpec(tmp.dir, { writable: false, resumeRef: 'session-abc' });
    expect(dshPatch(spec)).toContain('mode: "read-only"');
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(import.meta.url, 'no-json.jsonl').map((out) => ({ out })),
    });
    const runner = new DshRunner({
      keys: fakeKeys().broker,
      command: s.command,
      allowUnsandboxed: true,
      sandboxAvailable: () => false,
    });
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

  it('fails with auth before spawning when the server has no key, no proxy or a stopped one', async () => {
    const s = await writeScenario(tmp.dir, { responses: probe });
    for (const [keys, problem] of [
      [fakeKeys({ hasKey: false }).broker, 'OPENROUTER_API_KEY is not set'],
      [undefined, 'the model-key proxy is not running (docs/adr/0020)'],
    ] as const) {
      const runner = new DshRunner({
        ...(keys ? { keys } : {}),
        command: s.command,
        allowUnsandboxed: true,
        // the real key in the service's environment is never a fallback
        sourceEnv: { ...process.env, OPENROUTER_API_KEY: KEY },
      });
      const r = await runner.run(makeSpec(tmp.dir), new AbortController().signal);
      expect(r.error).toMatchObject({ kind: 'auth', message: problem });
      const caps = await runner.probe();
      expect(caps).toMatchObject({ available: false, credentials: 'missing' });
      expect(caps.problems).toContain(problem);
      expect(caps.flags).toEqual(['--json', '--patch', '--profile', '--session-id']);
    }
    const stopped = fakeKeys({ listening: false });
    const r = await new DshRunner({
      keys: stopped.broker,
      command: s.command,
      allowUnsandboxed: true,
    }).run(makeSpec(tmp.dir), new AbortController().signal);
    expect(r.error?.kind).toBe('auth');
    // probes only: nothing ran
    expect(
      readRecords(s.recordPath).every(
        (x) => x.argv.includes('--help') || x.argv.includes('--version'),
      ),
    ).toBe(true);
  });

  it('reports a missing binary as unavailable', async () => {
    const runner = new DshRunner({
      keys: fakeKeys().broker,
      sourceEnv: { PATH: join(tmp.dir, 'nothing') },
    });
    expect(await runner.probe()).toMatchObject({
      available: false,
      problems: ['dsh executable not found on PATH'],
    });
  });
});
