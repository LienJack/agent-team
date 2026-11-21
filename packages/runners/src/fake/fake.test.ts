import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReceipt } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunnerRegistry } from '../registry.js';
import { makeSpec, tempDir } from '../test-support.js';
import { defaultFakeFile } from './in-process.js';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

const prompt = (paths: string) =>
  `# 派工單 d_1\n## 工作規則\n- 只修改下列 owned_paths 內的檔案：${paths}。\n- 不要 git commit\n`;

describe('runners: in-process fake runner', () => {
  it('is registered under every runner name with fake: true', () => {
    const reg = createRunnerRegistry({ env: () => undefined, fake: true });
    expect(reg.names().sort()).toEqual(['claude', 'codex', 'dsh', 'fake']);
    expect(reg.get('codex')?.name).toBe('codex');
    expect(reg.fake('dsh')).toBe(reg.get('dsh'));
  });

  it('writes a file inside the first owned path and returns a valid receipt by default', async () => {
    const reg = createRunnerRegistry({ env: () => undefined, fake: true });
    const spec = makeSpec(tmp.dir, { prompt: prompt('`src/feature/`、`docs/a.md`') });
    const started: unknown[] = [];
    const r = await reg.get('claude')!.run(spec, new AbortController().signal, {
      onStarted: (i) => started.push(i),
    });
    const parsed = parseReceipt('impl', r.final);
    expect(parsed.ok && parsed.receipt.files_changed).toEqual([
      'src/feature/fake-d_fixture0001.txt',
    ]);
    expect(readFileSync(join(spec.cwd, 'src/feature/fake-d_fixture0001.txt'), 'utf8')).toContain(
      'd_fixture0001',
    );
    expect(started).toHaveLength(1);

    const review = await reg
      .get('codex')!
      .run(makeSpec(tmp.dir, { writable: false }), new AbortController().signal);
    expect(parseReceipt('review', review.final)).toMatchObject({
      ok: true,
      receipt: { verdict: 'pass' },
    });
  });

  it('derives default targets from owned paths', () => {
    const spec = (p: string) => makeSpec(tmp.dir, { prompt: prompt(p) });
    expect(defaultFakeFile(spec('`src/a.ts`'))).toBe('src/a.ts');
    expect(defaultFakeFile(spec('`src/**/*.ts`'))).toBe('src/fake-d_fixture0001.txt');
    expect(defaultFakeFile(spec('`lib`'))).toBe('lib/fake-d_fixture0001.txt');
    expect(defaultFakeFile(makeSpec(tmp.dir, { prompt: 'no paths' }))).toBe(
      'agent-team-fake/fake-d_fixture0001.txt',
    );
  });

  it('follows scripted steps: files, results, start outcomes, hold/release and abort', async () => {
    const reg = createRunnerRegistry({ env: () => undefined, fake: true });
    const fake = reg.fake('dsh')!;
    fake.script(
      { files: { 'x.txt': 'x' }, result: { error: { kind: 'rate_limit', message: 'slow down' } } },
      { start: 'unknown' },
      { hold: true },
      { hold: true },
    );
    const spec = makeSpec(tmp.dir);
    expect((await fake.run(spec, new AbortController().signal)).error?.kind).toBe('rate_limit');
    expect(readFileSync(join(spec.cwd, 'x.txt'), 'utf8')).toBe('x');
    expect((await fake.run(spec, new AbortController().signal)).error?.kind).toBe('start_unknown');

    const held = fake.run({ ...spec, dispatchId: 'd_held' }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.held()).toEqual(['d_held']);
    fake.release('d_held', { final: { custom: true } });
    expect((await held).final).toEqual({ custom: true });

    const ac = new AbortController();
    const aborted = fake.run({ ...spec, dispatchId: 'd_abort' }, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect((await aborted).error?.kind).toBe('cancelled');
    expect(fake.calls).toHaveLength(4);
  });

  it('caches probe results for capabilities()', async () => {
    const reg = createRunnerRegistry({ env: () => undefined, fake: true });
    expect(reg.capabilities('claude')).toBeUndefined();
    const all = await reg.probeAll();
    expect(all).toHaveLength(4);
    expect(reg.capabilities('claude')).toMatchObject({
      available: true,
      credentials: 'not_required',
    });
  });
});

describe('runners: real registry', () => {
  it('registers claude, codex and dsh (no fake) without probing at construction', () => {
    const reg = createRunnerRegistry({ env: () => undefined });
    expect(reg.names()).toEqual(['claude', 'codex', 'dsh']);
    expect(reg.capabilities('claude')).toBeUndefined();
    expect(reg.fake('claude')).toBeUndefined();
  });
});
