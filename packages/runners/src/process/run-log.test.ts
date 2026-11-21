import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_LOG_FILES } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRedactor } from '../redact.js';
import { tempDir } from '../test-support.js';
import { RunLog } from './run-log.js';

// Run logs hold prompts, tool output and receipts: the directory is 0700 and every file 0600,
// also when they already exist with looser modes (a resumed or re-run log dir, a restored backup).

let t: ReturnType<typeof tempDir>;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

describe('runners: run log permissions', () => {
  it('creates the dir 0700 and the files 0600', async () => {
    const dir = join(t.dir, 'runs', 'r_000001');
    const log = await RunLog.open(dir, makeRedactor());
    await log.writePrompt('prompt');
    log.event('{"type":"x"}');
    log.stderrLine('err');
    await log.close();
    expect(mode(dir)).toBe('700');
    for (const f of [RUN_LOG_FILES.events, RUN_LOG_FILES.stderr, RUN_LOG_FILES.prompt]) {
      expect({ f, mode: mode(join(dir, f)) }).toEqual({ f, mode: '600' });
    }
  });

  it('tightens an existing dir and existing files', async () => {
    const dir = join(t.dir, 'runs', 'r_000002');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    for (const f of [RUN_LOG_FILES.events, RUN_LOG_FILES.stderr, RUN_LOG_FILES.prompt]) {
      writeFileSync(join(dir, f), 'old\n');
      chmodSync(join(dir, f), 0o644);
    }
    const log = await RunLog.open(dir, makeRedactor());
    await log.writePrompt('prompt');
    log.event('{"type":"x"}');
    await log.close();
    expect(mode(dir)).toBe('700');
    for (const f of [RUN_LOG_FILES.events, RUN_LOG_FILES.stderr, RUN_LOG_FILES.prompt]) {
      expect({ f, mode: mode(join(dir, f)) }).toEqual({ f, mode: '600' });
    }
  });
});
