// Shared helpers for this package's tests (not exported from the package entry points).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptJsonSchema, type RunSpec } from '@agent-team/schema';

export function tempDir(prefix = 'agent-team-runners-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeSpec(dir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  const writable = overrides.writable ?? true;
  return {
    dispatchId: 'd_fixture0001',
    cwd: join(dir, 'work'),
    prompt: '# 派工單 d_fixture0001\n建立 hello.txt\n',
    schema: receiptJsonSchema(writable ? 'impl' : 'review'),
    model: 'claude-haiku-5-5',
    writable,
    logDir: join(dir, 'runs', 'r_000001'),
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** Lines of a recorded fixture next to `metaUrl` (`__fixtures__/<name>`). */
export function fixtureLines(metaUrl: string, name: string): string[] {
  return readFileSync(new URL(`./__fixtures__/${name}`, metaUrl), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

export function fixtureText(metaUrl: string, name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, metaUrl), 'utf8');
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `fn` is true or `ms` elapsed. */
export async function eventually(fn: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}
