// Test support: the scripted fake CLI (a real child process driven by a scenario file) and the
// in-process fake runner. Safe to import from other packages' tests (no vitest import).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { siblingScript } from '../process/module-path.js';
import type { FakeCliRecord, FakeScenario } from './fake-cli.js';

export type { FakeCliRecord, FakeCliResponse, FakeCliStep, FakeScenario } from './fake-cli.js';
export { InProcessFakeRunner, defaultFakeFile } from '../fake/in-process.js';

/** Absolute path of the fake CLI script (`.ts` from src, `.js` from dist). */
export function fakeCliPath(): string {
  return siblingScript(import.meta.url, 'fake-cli');
}

/** argv prefix that runs the fake CLI with `scenarioPath` (pass as a runner `command`). */
export function fakeCliCommand(scenarioPath: string): string[] {
  return [process.execPath, fakeCliPath(), '--fake-scenario', scenarioPath];
}

export interface WrittenScenario {
  scenarioPath: string;
  recordPath: string;
  /** argv prefix for the runner's `command` option. */
  command: string[];
}

/** Write `scenario` into `dir` (recordPath defaults to `<dir>/fake-cli-record.jsonl`). */
export async function writeScenario(
  dir: string,
  scenario: FakeScenario,
  name = 'scenario',
): Promise<WrittenScenario> {
  await mkdir(dir, { recursive: true });
  const scenarioPath = join(dir, `${name}.json`);
  const recordPath = scenario.recordPath ?? join(dir, `${name}-record.jsonl`);
  await writeFile(scenarioPath, JSON.stringify({ ...scenario, recordPath }, null, 2));
  return { scenarioPath, recordPath, command: fakeCliCommand(scenarioPath) };
}

/** Every invocation recorded so far (several lines per invocation keep the latest state last). */
export function readRecords(recordPath: string): FakeCliRecord[] {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FakeCliRecord);
}

/** The latest record of the invocation that was not a probe (`responses`) call. */
export function lastRecord(recordPath: string): FakeCliRecord | undefined {
  const all = readRecords(recordPath);
  return all[all.length - 1];
}

/** Whether a process is still alive (signal 0). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}
