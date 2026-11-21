import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../redact.js';
import { eventually, tempDir } from '../test-support.js';
import { processAlive } from '../testing/index.js';
import { parseCommand } from './argv.js';
import { createCheckExecutor } from './executor.js';

describe('runners: check command parsing', () => {
  it('splits plain commands into argv without a shell', () => {
    expect(parseCommand('pnpm test')).toEqual({ kind: 'argv', argv: ['pnpm', 'test'] });
    expect(parseCommand(`node -e 'console.log("a b")'  "x y" z\\ w`)).toEqual({
      kind: 'argv',
      argv: ['node', '-e', 'console.log("a b")', 'x y', 'z w'],
    });
    expect(parseCommand('"" a')).toEqual({ kind: 'argv', argv: ['', 'a'] });
  });

  it('falls back to sh -c for shell syntax', () => {
    for (const cmd of [
      'pnpm lint && pnpm test',
      'a | b',
      'echo $HOME',
      'ls *.ts',
      'FOO=1 pnpm test',
      'echo "unterminated',
      'cd ~',
    ]) {
      expect(parseCommand(cmd).kind).toBe('shell');
    }
  });
});

let tmp: ReturnType<typeof tempDir>;
let cwd: string;
beforeEach(() => {
  tmp = tempDir();
  cwd = join(tmp.dir, 'wt');
  mkdirSync(cwd);
});
afterEach(() => tmp.cleanup());

const node = JSON.stringify(process.execPath);

describe('runners: check executor', () => {
  const checks = createCheckExecutor({ killGraceMs: 300, allowUnsandboxed: true });

  it('passes, logs the full output and returns the last 20 lines', async () => {
    writeFileSync(
      join(cwd, 'many.mjs'),
      'for (let i = 1; i <= 30; i++) console.log("line " + i);\n',
    );
    const logPath = join(tmp.dir, 'runs', 'r_1', 'checks', '1-test.log');
    const out = await checks.run({
      cwd,
      name: 'test',
      cmd: `${node} many.mjs`,
      logPath,
      timeoutMs: 10_000,
    });
    expect(out).toMatchObject({ passed: true, exitCode: 0 });
    const tail = out.tail.split('\n');
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe('line 11');
    expect(tail[19]).toBe('line 30');
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('line 1\n');
    expect(log).toContain('[exit 0');
  });

  it('fails on a non-zero exit and redacts the output', async () => {
    const key = ['sk', 'proj', 'q'.repeat(40)].join('-');
    writeFileSync(join(cwd, 'fail.mjs'), `console.error("leak ${key}"); process.exit(3);\n`);
    const logPath = join(tmp.dir, 'fail.log');
    const out = await checks.run({
      cwd,
      name: 'lint',
      cmd: `${node} fail.mjs`,
      logPath,
      timeoutMs: 10_000,
    });
    expect(out).toMatchObject({ passed: false, exitCode: 3 });
    expect(out.tail).toContain(REDACTED);
    expect(readFileSync(logPath, 'utf8')).not.toContain(key);
  });

  it('runs shell syntax through sh -c in the worktree with the minimal environment', async () => {
    const out = await checks.run({
      cwd,
      name: 'sh',
      cmd: 'echo one && pwd && echo "${GIT_DIR:-no-git-dir}"',
      logPath: join(tmp.dir, 'sh.log'),
      timeoutMs: 10_000,
    });
    expect(out.passed).toBe(true);
    expect(out.tail.split('\n')[0]).toBe('one');
    expect(out.tail).toContain('no-git-dir');
  });

  it('kills the process group on timeout', async () => {
    writeFileSync(
      join(cwd, 'hang.mjs'),
      `import { spawn } from 'node:child_process';
       const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       console.log('child ' + c.pid); setInterval(() => {}, 1000);\n`,
    );
    const out = await checks.run({
      cwd,
      name: 'hang',
      cmd: `${node} hang.mjs`,
      logPath: join(tmp.dir, 'hang.log'),
      timeoutMs: 800,
    });
    expect(out).toMatchObject({ passed: false, exitCode: null });
    const pid = Number(/child (\d+)/.exec(out.tail)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await eventually(() => !processAlive(pid))).toBe(true);
  });

  it('treats a missing command as a failing check and a missing cwd as an infrastructure error', async () => {
    const out = await checks.run({
      cwd,
      name: 'x',
      cmd: 'definitely-not-a-command-agent-team',
      logPath: join(tmp.dir, 'x.log'),
      timeoutMs: 5000,
    });
    expect(out).toMatchObject({ passed: false, exitCode: 127 });
    await expect(
      checks.run({
        cwd: join(tmp.dir, 'gone'),
        name: 'x',
        cmd: 'true',
        logPath: join(tmp.dir, 'y.log'),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('runners: checks fail closed without a sandbox (docs/adr/0019)', () => {
  const probe = () => {
    writeFileSync(
      join(cwd, 'touch.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'x');\n`,
    );
    return { cwd, name: 'unit', cmd: `${node} touch.mjs`, timeoutMs: 5000 };
  };

  it('does not run the command when no sandbox is available, and says why', async () => {
    for (const checks of [
      createCheckExecutor(), // no policy at all
      createCheckExecutor({ sandbox: { denyPaths: [] }, sandboxAvailable: () => false }), // Linux
    ]) {
      const logPath = join(tmp.dir, `refused-${Math.random()}.log`);
      const out = await checks.run({ ...probe(), logPath });
      expect(out.passed).toBe(false);
      expect(out.refused).toMatch(/checks\.allow_unsandboxed/);
      expect(existsSync(join(cwd, 'ran.txt'))).toBe(false);
      expect(readFileSync(logPath, 'utf8')).toMatch(/\[not run\]/);
    }
  });

  it('runs it unsandboxed only when checks.allow_unsandboxed is set (and logs that)', async () => {
    const checks = createCheckExecutor({ allowUnsandboxed: true, sandboxAvailable: () => false });
    const logPath = join(tmp.dir, 'opt-in.log');
    const out = await checks.run({ ...probe(), logPath });
    expect(out).toMatchObject({ passed: true });
    expect(out.refused).toBeUndefined();
    expect(existsSync(join(cwd, 'ran.txt'))).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toMatch(/UNSANDBOXED/);
  });

  it('tightens an existing log file and directory to 0600 / 0700', async () => {
    const dir = join(tmp.dir, 'logs');
    mkdirSync(dir, { mode: 0o755 });
    const logPath = join(dir, 'c.log');
    writeFileSync(logPath, 'old', { mode: 0o644 });
    chmodSync(dir, 0o755);
    chmodSync(logPath, 0o644);
    await createCheckExecutor({ allowUnsandboxed: true }).run({ ...probe(), logPath });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });
});
