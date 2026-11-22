import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { receiptJsonSchema } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_WEB_DENIED_TOOLS } from './claude/sandbox.js';
import { ClaudeRunner } from './claude/runner.js';
import {
  CODEX_EXEC_FLAGS,
  CODEX_ISOLATION_FLAGS,
  CODEX_WEB_FLAGS,
  CodexRunner,
} from './codex/runner.js';
import { CODEX_WEB_DISABLED_FEATURES } from './codex/sandbox.js';
import { DSH_NO_RESEARCH, DshRunner } from './dsh/runner.js';
import { InProcessFakeRunner } from './fake/in-process.js';
import { fakeKeys, fixtureLines, fixtureText, makeSpec, tempDir } from './test-support.js';
import { lastRecord, readRecords, writeScenario, type FakeCliResponse } from './testing/index.js';

// spec §17: research runs (`RunSpec.web`) get web tools only — no file or shell tool — in an
// empty directory. Which runners can (probe `supports.webSearch`) and the exact argv/settings,
// pinned against the scripted CLI before any real run.

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'research', 'r_000001'), { recursive: true });
});
afterEach(() => tmp.cleanup());

const webSpec = () =>
  makeSpec(tmp.dir, {
    cwd: join(tmp.dir, 'research', 'r_000001'),
    writable: false,
    web: true,
    schema: receiptJsonSchema('research'),
    sandbox: { allowNetwork: false },
  });

// ---------------------------------------------------------------------------- claude

const CLAUDE_HELP = fixtureText(new URL('./claude/x', import.meta.url).href, 'help.txt');
const claudeProbe = (help = CLAUDE_HELP): FakeCliResponse[] => [
  { argv: ['--version'], stdout: '2.1.326 (Claude Code)' },
  { argv: ['--help'], stdout: help },
  { argv: ['auth', 'status', '--json'], stdout: JSON.stringify({ loggedIn: true }) },
];
const claudeSuccess = fixtureLines(new URL('./claude/x', import.meta.url).href, 'success.jsonl');

describe('§17 research runs: claude', () => {
  it('WebSearch and WebFetch only, file and shell tools refused three times, sandbox on', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: claudeProbe(),
      steps: claudeSuccess.map((out) => ({ out })),
    });
    const runner = new ClaudeRunner({
      command: s.command,
      sandbox: { denyPaths: [join(tmp.dir, 'data')], home: join(tmp.dir, 'home') },
    });
    const caps = await runner.probe();
    expect(caps.supports.webSearch).toBe(true);
    const spec = webSpec();
    await runner.run(spec, new AbortController().signal);
    const argv = lastRecord(s.recordPath)!.argv;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after('--tools')).toBe('WebSearch,WebFetch');
    expect(after('--allowedTools')).toBe('WebSearch,WebFetch');
    expect(after('--disallowedTools')).toBe(CLAUDE_WEB_DENIED_TOOLS.join(','));
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) {
      expect(argv).toContain(flag);
    }
    expect(after('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(after('--permission-mode')).toBe('dontAsk');
    const settings = JSON.parse(after('--settings')!) as {
      permissions: { deny: string[] };
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        autoAllowBashIfSandboxed: boolean;
        filesystem: { allowRead: string[]; denyRead: string[] };
        network: { allowedDomains: string[]; strictAllowlist: boolean; allowLocalBinding: boolean };
      };
    };
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']),
    );
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
    });
    expect(settings.sandbox.filesystem.allowRead).toEqual([spec.cwd]);
    expect(settings.sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([join(tmp.dir, 'data'), join(tmp.dir, 'home')]),
    );
    // the worker tool lists appear nowhere
    expect(argv).not.toContain('Read,Edit,Write,Glob,Grep,Bash');
    expect(argv).not.toContain('Read,Glob,Grep');
  });

  it('a CLI without --tools cannot run research: probe says so and nothing is spawned', async () => {
    const help = CLAUDE_HELP.split('\n')
      .filter((l) => !l.includes('--tools'))
      .join('\n');
    const s = await writeScenario(tmp.dir, { responses: claudeProbe(help), steps: [] });
    const runner = new ClaudeRunner({ command: s.command });
    expect((await runner.probe()).supports.webSearch).toBe(false);
    const r = await runner.run(webSpec(), new AbortController().signal);
    expect(r.error).toMatchObject({ kind: 'crash', message: expect.stringContaining('research') });
    expect(readRecords(s.recordPath)).toHaveLength(3); // the probe only
  });
});

// ----------------------------------------------------------------------------- codex

const codexProbe = (flags: readonly string[]): FakeCliResponse[] => [
  { argv: ['--version'], stdout: 'codex-cli 0.171.0' },
  { argv: ['exec', '--help'], stdout: [...flags, '--json'].map((f) => `  ${f} <x>`).join('\n') },
  { argv: ['login', 'status'], stdout: 'Logged in using ChatGPT' },
];
const ALL_CODEX = [...CODEX_EXEC_FLAGS, ...CODEX_ISOLATION_FLAGS, ...CODEX_WEB_FLAGS];
const codexSuccess = fixtureLines(new URL('./codex/x', import.meta.url).href, 'success.jsonl');

describe('§17 research runs: codex', () => {
  it('live web search, every other tool feature disabled, a profile denying the filesystem', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: codexProbe(ALL_CODEX),
      steps: codexSuccess.map((out) => ({ out })),
    });
    const runner = new CodexRunner({ command: s.command, sandbox: { denyPaths: ['/data'] } });
    expect((await runner.probe()).supports.webSearch).toBe(true);
    const spec = webSpec();
    await runner.run(spec, new AbortController().signal);
    const argv = lastRecord(s.recordPath)!.argv;
    for (const feature of CODEX_WEB_DISABLED_FEATURES) {
      const at = argv.findIndex((a, i) => a === feature && argv[i - 1] === '--disable');
      expect({ feature, at: at > 0 }).toEqual({ feature, at: true });
    }
    expect(argv).toContain('web_search="live"');
    expect(argv).not.toContain('web_search="disabled"');
    expect(argv).toContain('permissions.agent-team.filesystem={":root"="deny"}');
    expect(argv).toContain('permissions.agent-team.network={enabled=false}');
    expect(argv.join(' ')).not.toContain('"read"');
    expect(argv.join(' ')).not.toContain('"write"');
    expect(argv).not.toContain('--sandbox');
    expect(argv[argv.indexOf('--cd') + 1]).toBe(spec.cwd);
    // isolation flags still first
    expect(argv.slice(0, 3)).toEqual(['exec', '--ignore-user-config', '--ignore-rules']);
  });

  it('impl/review runs keep web search disabled', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: codexProbe(ALL_CODEX),
      steps: codexSuccess.map((out) => ({ out })),
    });
    await new CodexRunner({ command: s.command }).run(
      makeSpec(tmp.dir, { writable: false, schema: receiptJsonSchema('review') }),
      new AbortController().signal,
    );
    const argv = lastRecord(s.recordPath)!.argv;
    expect(argv).toContain('web_search="disabled"');
    expect(argv).not.toContain('--disable');
  });

  it('without --disable the probe reports no webSearch and research runs are refused', async () => {
    const s = await writeScenario(tmp.dir, {
      responses: codexProbe([...CODEX_EXEC_FLAGS, ...CODEX_ISOLATION_FLAGS]),
      steps: [],
    });
    const runner = new CodexRunner({ command: s.command });
    const caps = await runner.probe();
    expect(caps).toMatchObject({ available: true, supports: { webSearch: false } });
    const r = await runner.run(webSpec(), new AbortController().signal);
    expect(r.error?.kind).toBe('crash');
    expect(lastRecord(s.recordPath)!.argv).toEqual(['login', 'status']);
  });
});

// ------------------------------------------------------------------------- dsh, fake

describe('§17 research runs: dsh and the in-process fake', () => {
  it('dsh is never webSearch-capable and refuses research runs without spawning', async () => {
    const dshDir = new URL('./dsh/x', import.meta.url).href;
    const s = await writeScenario(tmp.dir, {
      responses: [
        { argv: ['--version'], stdout: '0.2.1-rc.5' },
        { argv: ['--help'], stdout: fixtureText(dshDir, 'help.txt') },
        {
          argv: ['--profile', 'headless', '--help'],
          stdout: fixtureText(dshDir, 'headless-help.txt'),
        },
      ],
      steps: [],
    });
    const runner = new DshRunner({
      keys: fakeKeys().broker,
      command: s.command,
      allowUnsandboxed: true,
      sandboxAvailable: () => false,
    });
    const caps = await runner.probe();
    expect(caps.available).toBe(true);
    expect(caps.supports.webSearch).toBe(false);
    const r = await runner.run(webSpec(), new AbortController().signal);
    expect(r.error).toEqual({ kind: 'crash', message: DSH_NO_RESEARCH });
    expect(readRecords(s.recordPath)).toHaveLength(3); // the probe only, no run
    expect(readRecords(s.recordPath).some((x) => x.argv.includes('--json'))).toBe(false);
  });

  it('the in-process fake answers research specs with a valid research receipt', async () => {
    const fake = new InProcessFakeRunner('claude');
    expect((await fake.probe()).supports.webSearch).toBe(true);
    const r = await fake.run(webSpec(), new AbortController().signal);
    expect(r.final).toMatchObject({
      dispatch_id: 'd_fixture0001',
      recommendation: 'reference_only',
    });
  });
});
