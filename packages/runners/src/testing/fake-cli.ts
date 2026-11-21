// Scripted fake CLI (spec §7 fake). A real child process that stands in for claude / codex /
// dsh in tests. Standalone script: node builtins only, erasable TypeScript (Node runs it from
// src/ and dist/ alike).
//
// Invocation: `node fake-cli.(ts|js) --fake-scenario <scenario.json> <args the runner passes…>`.
// It records (appending one JSON line per invocation to `scenario.recordPath`) the argv it
// received, the NAMES of its environment variables (never values), its cwd, the stdin text and
// whether stdin reached EOF (was closed), then either answers a probe `response` whose argv
// matches exactly or plays the scenario `steps`.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FakeCliStep {
  /** stdout line (objects are JSON-encoded) */
  out?: unknown;
  /** stderr line */
  err?: string;
  /** delay before this step, divided by the speed factor */
  delayMs?: number;
  /** write a file relative to cwd */
  writeFile?: { path: string; content: string };
  /** spawn a long-lived grandchild in the same process group */
  spawnChild?: boolean;
  /** never exit on our own */
  hang?: boolean;
  /** kill ourselves with this signal */
  crash?: string;
  /** exit with this code */
  exit?: number;
}

export interface FakeCliResponse {
  argv: string[];
  stdout?: string;
  stderr?: string;
  exit?: number;
}

export interface FakeScenario {
  recordPath?: string;
  speed?: number;
  /** ignore SIGTERM (tests SIGKILL escalation) */
  ignoreSigterm?: boolean;
  /** how long to wait for stdin EOF before recording stdinClosed: false */
  stdinWaitMs?: number;
  responses?: FakeCliResponse[];
  steps?: FakeCliStep[];
}

export interface FakeCliRecord {
  argv: string[];
  envNames: string[];
  cwd: string;
  pid: number;
  stdin: string;
  stdinClosed: boolean;
  children: number[];
}

function readStdin(waitMs: number): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      process.stdin.pause();
      resolve({ text: Buffer.concat(chunks).toString('utf8'), closed });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.once('end', () => {
      clearTimeout(timer);
      finish(true);
    });
    process.stdin.once('error', () => {
      clearTimeout(timer);
      finish(true);
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const all = process.argv.slice(2);
  const at = all.indexOf('--fake-scenario');
  if (at < 0 || at + 1 >= all.length) {
    process.stderr.write('fake-cli: --fake-scenario <file> is required\n');
    process.exit(2);
  }
  const scenarioPath = all[at + 1]!;
  const argv = [...all.slice(0, at), ...all.slice(at + 2)];
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as FakeScenario;
  const speed = scenario.speed && scenario.speed > 0 ? scenario.speed : 1;
  if (scenario.ignoreSigterm) process.on('SIGTERM', () => {});

  const stdin = await readStdin(scenario.stdinWaitMs ?? 1500);
  const record: FakeCliRecord = {
    argv,
    envNames: Object.keys(process.env).sort(),
    cwd: process.cwd(),
    pid: process.pid,
    stdin: stdin.text,
    stdinClosed: stdin.closed,
    children: [],
  };
  const save = () => {
    if (!scenario.recordPath) return;
    mkdirSync(dirname(scenario.recordPath), { recursive: true });
    appendFileSync(scenario.recordPath, `${JSON.stringify(record)}\n`);
  };

  const response = scenario.responses?.find(
    (r) => r.argv.length === argv.length && r.argv.every((a, i) => a === argv[i]),
  );
  if (response) {
    save();
    if (response.stdout) process.stdout.write(`${response.stdout}\n`);
    if (response.stderr) process.stderr.write(`${response.stderr}\n`);
    process.exitCode = response.exit ?? 0;
    return;
  }

  save();
  for (const step of scenario.steps ?? []) {
    if (step.delayMs) await sleep(step.delayMs / speed);
    if (step.out !== undefined) {
      process.stdout.write(
        `${typeof step.out === 'string' ? step.out : JSON.stringify(step.out)}\n`,
      );
    }
    if (step.err !== undefined) process.stderr.write(`${step.err}\n`);
    if (step.writeFile) {
      const target = join(process.cwd(), step.writeFile.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, step.writeFile.content);
    }
    if (step.spawnChild) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      if (child.pid !== undefined) record.children.push(child.pid);
      save(); // the last line of an invocation carries the grandchild pids
    }
    if (step.crash) {
      process.kill(process.pid, step.crash as NodeJS.Signals);
      await sleep(1000);
    }
    if (step.exit !== undefined) process.exit(step.exit);
    if (step.hang) {
      setInterval(() => {}, 1000);
      await new Promise<void>(() => {});
    }
  }
}

void main();
