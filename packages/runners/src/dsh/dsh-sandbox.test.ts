import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSandboxAvailable, SANDBOX_EXEC } from '../checks/sandbox.js';
import { fixtureLines, makeSpec, tempDir } from '../test-support.js';
import { lastRecord, readRecords, writeScenario, type FakeCliResponse } from '../testing/index.js';
import { DSH_PATCH_FILE, DSH_STATE_DIR } from './args.js';
import { DSH_UNSANDBOXED_PROBLEM, DshRunner, dshGitEnv } from './runner.js';
import { dshSandboxProfile } from './sandbox.js';

// docs/adr/0019: dsh runs under Seatbelt with the worker deny list; without sandbox-exec it is
// unavailable unless `runners.dsh.allow_unsandboxed` is set.

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const probe: FakeCliResponse[] = [
  { argv: ['--version'], stdout: '0.2.1-rc.5' },
  { argv: ['--help'], stdout: '  --profile <name>\n  --patch <path>' },
  { argv: ['--profile', 'headless', '--help'], stdout: '  --json\n  --session-id <id>' },
];

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'));
});
afterEach(() => tmp.cleanup());

describe('dsh without a sandbox fails closed', () => {
  it('is unavailable and never spawns, unless allow_unsandboxed', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(new URL('./dsh.test.ts', import.meta.url).href, 'success.jsonl').map(
        (out) => ({ out }),
      ),
    });
    const closed = new DshRunner({
      env: () => KEY,
      command: s.command,
      sandboxAvailable: () => false,
    });
    const caps = await closed.probe();
    expect(caps.available).toBe(false);
    expect(caps.problems).toContain(DSH_UNSANDBOXED_PROBLEM);
    const spawnsBefore = readRecords(s.recordPath).length;
    const r = await closed.run(makeSpec(tmp.dir), new AbortController().signal);
    expect(r.error?.kind).toBe('crash');
    expect(r.error?.message).toMatch(/allow_unsandboxed/);
    expect(readRecords(s.recordPath)).toHaveLength(spawnsBefore); // nothing ran

    const open = new DshRunner({
      env: () => KEY,
      command: s.command,
      sandboxAvailable: () => false,
      allowUnsandboxed: true,
    });
    expect((await open.probe()).available).toBe(true);
    const ok = await open.run(makeSpec(tmp.dir), new AbortController().signal);
    expect(ok.error).toBeUndefined();
  });
});

describe.skipIf(!checkSandboxAvailable())('dsh under Seatbelt (macOS)', () => {
  function layout() {
    const home = join(tmp.dir, 'home');
    const data = join(tmp.dir, 'data');
    const logDir = join(data, 'runs', 'r_1');
    const state = join(logDir, DSH_STATE_DIR);
    for (const d of [
      join(home, '.dsh', 'profiles'),
      join(home, '.ssh'),
      join(data, 'run'),
      state,
    ]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(data, 'run', 'listener.json'), '{"token":"t"}\n');
    writeFileSync(join(home, '.dsh', '.credentials.yaml'), 'secret\n');
    writeFileSync(join(home, '.dsh', 'profiles', 'p.yml'), 'profile\n');
    writeFileSync(join(home, '.ssh', 'id'), 'key\n');
    writeFileSync(join(logDir, DSH_PATCH_FILE), 'patch\n');
    const cwd = join(tmp.dir, 'work');
    writeFileSync(join(cwd, '.git'), 'gitdir: /x\n');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    return { home, data, logDir, state, cwd };
  }
  const sh = (profile: string, cmd: string, cwd: string) =>
    spawnSync(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', cmd], { cwd, encoding: 'utf8' })
      .status;

  it('denies DATA, credentials and other writes; allows the worktree and its own state', () => {
    const l = layout();
    const profile = (writable: boolean) =>
      dshSandboxProfile(
        {
          cwd: l.cwd,
          writable,
          stateDir: l.state,
          patchPath: join(l.logDir, DSH_PATCH_FILE),
          dshHome: join(l.home, '.dsh'),
        },
        { home: l.home, denyPaths: [l.data] },
      );
    const rw = profile(true);
    expect(sh(rw, `cat ${JSON.stringify(join(l.data, 'run', 'listener.json'))}`, l.cwd)).not.toBe(
      0,
    );
    expect(
      sh(rw, `cat ${JSON.stringify(join(l.home, '.dsh', '.credentials.yaml'))}`, l.cwd),
    ).not.toBe(0);
    expect(sh(rw, `cat ${JSON.stringify(join(l.home, '.ssh', 'id'))}`, l.cwd)).not.toBe(0);
    expect(sh(rw, `echo x > ${JSON.stringify(join(l.home, '.zshrc'))}`, l.cwd)).not.toBe(0);
    expect(sh(rw, 'printf "gitdir: /primary\\n" > .git', l.cwd)).not.toBe(0);
    expect(readFileSync(join(l.cwd, '.git'), 'utf8')).toBe('gitdir: /x\n');
    // what dsh needs
    expect(sh(rw, `cat ${JSON.stringify(join(l.home, '.dsh', 'profiles', 'p.yml'))}`, l.cwd)).toBe(
      0,
    );
    expect(sh(rw, `cat ${JSON.stringify(join(l.logDir, DSH_PATCH_FILE))}`, l.cwd)).toBe(0);
    expect(sh(rw, `echo s > ${JSON.stringify(join(l.state, 's.jsonl'))}`, l.cwd)).toBe(0);
    expect(sh(rw, 'cat a.txt && echo b > b.txt', l.cwd)).toBe(0);
    expect(existsSync(join(l.cwd, 'b.txt'))).toBe(true);
    // the rest of the run's log dir (events, prompt) stays closed
    expect(sh(rw, `ls ${JSON.stringify(l.logDir)}`, l.cwd)).not.toBe(0);
    // read-only runs cannot write the worktree
    expect(sh(profile(false), 'echo c > c.txt', l.cwd)).not.toBe(0);
    expect(existsSync(join(l.cwd, 'c.txt'))).toBe(false);
  });

  it('the runner starts dsh through sandbox-exec, with its state redirected into the run', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(new URL('./dsh.test.ts', import.meta.url).href, 'success.jsonl').map(
        (out) => ({ out }),
      ),
    });
    const spec = makeSpec(tmp.dir);
    const r = await new DshRunner({ env: () => KEY, command: s.command }).run(
      spec,
      new AbortController().signal,
    );
    expect(r.error).toBeUndefined();
    expect(lastRecord(s.recordPath)!.argv.at(-1)).toBe('-');
    const patch = readFileSync(join(spec.logDir, DSH_PATCH_FILE), 'utf8');
    expect(patch).toContain('- id: session-persistence-jsonl');
    // dsh's own bash sandbox cannot nest inside Seatbelt: off, the outer profile confines it
    expect(patch).toContain('mode: "danger-full-access"');
    expect(patch).not.toContain('workspace-write');
    expect(patch).toContain(
      `root: ${JSON.stringify(join(spec.logDir, DSH_STATE_DIR, 'sessions'))}`,
    );
    expect(patch).toContain(
      `root: ${JSON.stringify(join(spec.logDir, DSH_STATE_DIR, 'storages'))}`,
    );
  });
});

describe.skipIf(!checkSandboxAvailable())(
  'why dsh runs its tools unconfined by itself (macOS)',
  () => {
    it('a nested sandbox-exec is refused under any profile with a deny rule', () => {
      const nested = spawnSync(
        SANDBOX_EXEC,
        [
          '-p',
          '(version 1)(allow default)(deny file-read* (subpath "/private/var/empty-nothing"))',
          SANDBOX_EXEC,
          '-p',
          '(version 1)(allow default)',
          '/usr/bin/true',
        ],
        { encoding: 'utf8' },
      );
      expect(nested.status).not.toBe(0);
      expect(nested.stderr).toMatch(/sandbox_apply: Operation not permitted/);
    });
  },
);

describe('git inside dsh (2026-11-21 sanity pass: "missing config key GIT_CONFIG_KEY_0")', () => {
  // dsh-subprocess drops variables whose NAME matches this before running bash
  const DSH_SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i;

  it("the git env survives dsh's subprocess filter (no *_KEY_* names)", async () => {
    const env = dshGitEnv('/state');
    for (const name of Object.keys(env)) expect(name).not.toMatch(DSH_SENSITIVE);
    const s = await writeScenario(tmp.dir, {
      responses: probe,
      steps: fixtureLines(new URL('./dsh.test.ts', import.meta.url).href, 'success.jsonl').map(
        (out) => ({ out }),
      ),
    });
    await new DshRunner({ env: () => KEY, command: s.command, allowUnsandboxed: true }).run(
      makeSpec(tmp.dir),
      new AbortController().signal,
    );
    const names = lastRecord(s.recordPath)!.envNames;
    expect(names).toEqual(expect.arrayContaining(['GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME']));
    expect(names.filter((n) => n.startsWith('GIT_CONFIG_') && n !== 'GIT_CONFIG_GLOBAL')).toEqual(
      [],
    );
  });

  it.skipIf(!checkSandboxAvailable())('git status works under the dsh profile with it', () => {
    const home = join(tmp.dir, 'home');
    const data = join(tmp.dir, 'data');
    const state = join(data, 'runs', 'r_1', DSH_STATE_DIR);
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    mkdirSync(join(state, 'xdg'), { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = x\n');
    writeFileSync(join(home, '.config', 'git', 'ignore'), '*.log\n');
    const cwd = join(tmp.dir, 'work');
    spawnSync('git', ['init', '-q'], { cwd, env: { PATH: process.env['PATH'] ?? '' } });
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    const profile = dshSandboxProfile(
      { cwd, writable: true, stateDir: state, patchPath: join(data, 'runs', 'r_1', 'p.yml') },
      { home, denyPaths: [data] },
    );
    const r = spawnSync(SANDBOX_EXEC, ['-p', profile, 'git', 'status', '--short'], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ...dshGitEnv(state) },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('?? a.txt');
  });
});
