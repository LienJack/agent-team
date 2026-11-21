import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CliDriver from '../cli-driver.js';
import type { CliRunInput } from '../cli-driver.js';
import { checkSandboxAvailable, SANDBOX_EXEC } from '../checks/sandbox.js';
import { fakeKeys, fixtureLines, makeSpec, tempDir } from '../test-support.js';
import { lastRecord, readRecords, writeScenario, type FakeCliResponse } from '../testing/index.js';
import { DSH_PATCH_FILE, DSH_STATE_DIR } from './args.js';
import { DSH_UNSANDBOXED_PROBLEM, DshRunner, dshGitEnv } from './runner.js';
import { dshSandboxProfile } from './sandbox.js';

// docs/adr/0019: dsh runs under Seatbelt with the worker deny list; without sandbox-exec it is
// unavailable unless `runners.dsh.allow_unsandboxed` is set.

// what the runner hands to the spawn (command and argv), recorded around the real driver
const launches = vi.hoisted(() => [] as Array<Pick<CliRunInput, 'command' | 'args'>>);
vi.mock('../cli-driver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CliDriver>();
  return {
    ...actual,
    runCli: (input: CliRunInput) => {
      launches.push({ command: input.command, args: input.args });
      return actual.runCli(input);
    },
  };
});
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
      keys: fakeKeys().broker,
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
      keys: fakeKeys().broker,
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
    const dsh = join(home, '.dsh');
    const logDir = join(data, 'runs', 'r_1');
    const state = join(logDir, DSH_STATE_DIR);
    for (const d of [join(home, '.ssh'), join(data, 'run'), state]) {
      mkdirSync(d, { recursive: true });
    }
    // ~/.dsh as a real one looks (docs/adr/0019 round 3): only profiles/headless is the run's
    const files: Record<string, string> = {
      'profiles/headless/cordis.yml': '[]\n',
      'profiles/headless/cordis.patch.yml': '- id: x\n',
      'profiles/headless/package.json': '{}\n',
      'profiles/web/cordis.patch.yml': 'other profile\n',
      '.credentials.yaml': 'secret\n',
      '.env': 'OPENROUTER_API_KEY=x\n',
      '.anonymous-user-id': 'id\n',
      '.agent-presets/p/agent.cordis.yml': 'preset\n',
      'sessions/s/a.jsonl': 'other session\n',
      'storages/x.json': '{}\n',
      'attachments/a.png': 'img\n',
      'cache/attachments/request-images/ab/c.jpg': 'img\n',
      'llm-deepseek/files-v3.json': '{}\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dsh, rel, '..'), { recursive: true });
      writeFileSync(join(dsh, rel), text);
    }
    writeFileSync(join(data, 'run', 'listener.json'), '{"token":"t"}\n');
    writeFileSync(join(home, '.ssh', 'id'), 'key\n');
    writeFileSync(join(logDir, DSH_PATCH_FILE), 'patch\n');
    const cwd = join(tmp.dir, 'work');
    writeFileSync(join(cwd, '.git'), 'gitdir: /x\n');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    return { home, data, dsh, logDir, state, cwd, files };
  }
  const sh = (profile: string, cmd: string, cwd: string) =>
    spawnSync(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', cmd], { cwd, encoding: 'utf8' })
      .status;
  const cat = (p: string) => `cat ${JSON.stringify(p)}`;

  it('denies DATA, credentials and other writes; allows the worktree and its own state', () => {
    const l = layout();
    const profile = (writable: boolean) =>
      dshSandboxProfile(
        {
          cwd: l.cwd,
          writable,
          stateDir: l.state,
          patchPath: join(l.logDir, DSH_PATCH_FILE),
          dshHome: l.dsh,
        },
        { home: l.home, denyPaths: [l.data] },
      );
    const rw = profile(true);
    expect(sh(rw, cat(join(l.data, 'run', 'listener.json')), l.cwd)).not.toBe(0);
    expect(sh(rw, cat(join(l.home, '.ssh', 'id')), l.cwd)).not.toBe(0);
    expect(sh(rw, `echo x > ${JSON.stringify(join(l.home, '.zshrc'))}`, l.cwd)).not.toBe(0);
    expect(sh(rw, 'printf "gitdir: /primary\\n" > .git', l.cwd)).not.toBe(0);
    expect(readFileSync(join(l.cwd, '.git'), 'utf8')).toBe('gitdir: /x\n');
    // ~/.dsh is an allow-list: the booted profile's directory only
    for (const rel of Object.keys(l.files)) {
      expect({ rel, read: sh(rw, cat(join(l.dsh, rel)), l.cwd) === 0 }).toEqual({
        rel,
        read: rel.startsWith('profiles/headless/'),
      });
    }
    expect(sh(rw, `ls ${JSON.stringify(join(l.dsh, 'sessions'))}`, l.cwd)).not.toBe(0);
    expect(sh(rw, `ls ${JSON.stringify(l.dsh)}`, l.cwd)).not.toBe(0);
    // dsh resets its root config on boot: that file is writable, its patch layer is not
    const root = join(l.dsh, 'profiles/headless/cordis.yml');
    expect(sh(rw, `echo '[]' > ${JSON.stringify(root)}`, l.cwd)).toBe(0);
    const patchLayer = join(l.dsh, 'profiles/headless/cordis.patch.yml');
    expect(sh(rw, `echo x > ${JSON.stringify(patchLayer)}`, l.cwd)).not.toBe(0);
    // what dsh needs
    expect(sh(rw, cat(join(l.logDir, DSH_PATCH_FILE)), l.cwd)).toBe(0);
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
    const keys = fakeKeys({ port: 47_123 });
    const data = join(tmp.dir, 'data');
    mkdirSync(data);
    launches.length = 0;
    const r = await new DshRunner({
      keys: keys.broker,
      command: s.command,
      sandbox: { denyPaths: [data], servicePorts: () => [47_100, keys.port] },
    }).run(spec, new AbortController().signal);
    expect(r.error).toBeUndefined();
    // the spawn: sandbox-exec -p <profile> <dsh> <dsh argv>
    expect(launches).toHaveLength(1);
    const { command, args } = launches[0]!;
    const patchPath = join(spec.logDir, DSH_PATCH_FILE);
    expect(command).toBe(SANDBOX_EXEC);
    expect(args.slice(0, 1)).toEqual(['-p']);
    expect(args.slice(2)).toEqual([
      ...s.command,
      '--profile',
      'headless',
      '--patch',
      patchPath,
      '--json',
      '-',
    ]);
    const profile = args[1]!;
    expect(profile.startsWith('(version 1)\n(allow default)\n')).toBe(true);
    for (const rule of [
      '(deny signal)',
      '(allow signal (target same-sandbox))',
      '(deny file-write* (subpath "/"))',
      `(deny file-read* (subpath ${JSON.stringify(realpathSync(homedir()))}))`,
      `(subpath ${JSON.stringify(realpathSync(data))})`,
      `(allow file-read* file-write* (subpath ${JSON.stringify(join(realpathSync(spec.logDir), DSH_STATE_DIR))}))`,
      '(deny network-outbound (remote ip "*:47100"))',
    ]) {
      expect(profile).toContain(rule);
    }
    // the key proxy's port is the one service port dsh may reach
    expect(profile).not.toContain(`*:${keys.port}`);
    // it ran inside: the fake dsh recorded its invocation
    expect(lastRecord(s.recordPath)!.argv.at(-1)).toBe('-');
    expect(keys.opened).toEqual([expect.objectContaining({ revoked: true })]);
    const patch = readFileSync(patchPath, 'utf8');
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
    expect(patch).toContain(`baseURL: "http://127.0.0.1:${keys.port}/api/v1"`);
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
    await new DshRunner({
      keys: fakeKeys().broker,
      command: s.command,
      allowUnsandboxed: true,
    }).run(makeSpec(tmp.dir), new AbortController().signal);
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
