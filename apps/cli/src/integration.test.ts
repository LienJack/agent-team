import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectLocal } from '@agent-team/client/node';
import type { RunSpec } from '@agent-team/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { captureIo } from './testing.js';

// Drives the real server in-process over real HTTP. apps may not import each other (spec §3),
// so the server's test harness is loaded by a runtime-resolved path (this file only).
interface ServerHarness {
  service: { start(): Promise<unknown>; stop(): Promise<void> };
  runners: { dsh: { defaultStep: unknown } };
  git: { touch(path: string, files: string[]): void };
  dataDir: string;
  cleanup(): Promise<void>;
}
const harnessPath = fileURLToPath(new URL('../../server/src/testing/harness.ts', import.meta.url));

let server: ServerHarness;
let work: string;
let env: Record<string, string>;

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(harnessPath).href)) as {
    createTestService(): ServerHarness;
  };
  server = mod.createTestService();
  let n = 0;
  server.runners.dsh.defaultStep = {
    onRun: (spec: RunSpec) => {
      if (spec.writable) server.git.touch(spec.cwd, [`src/a/f${++n}.ts`]);
    },
  };
  await server.service.start();
  work = mkdtempSync(join(tmpdir(), 'team-cli-'));
  env = { AGENT_TEAM_HOME: server.dataDir };
});

afterAll(async () => {
  await server.cleanup();
  rmSync(work, { recursive: true, force: true });
});

async function team(...argv: string[]) {
  const io = captureIo(() => connectLocal({ env }), {
    cwd: work,
    env,
    readFile: (path) => readFile(path, 'utf8'),
  });
  const code = await runCli(argv, io);
  return { code, out: io.text(), err: io.err.join('') };
}

describe('§14 cli — against the real server', () => {
  it('project add → task add → queue → done → receipt, watch, attention, resume', async () => {
    expect((await team('status')).out).toContain('tasks: pending 0');

    const project = await team(
      'project',
      'add',
      'demo',
      '/repos/demo',
      '--check',
      'test=pnpm test',
    );
    expect(project).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^p_\w+ demo \/repos\/demo/),
    });

    writeFileSync(join(work, 'ticket.md'), '# 派工單\n做 a\n');
    const added = await team(
      'task',
      'add',
      '--project',
      'demo',
      '--title',
      '加入 a',
      '--tier',
      'C',
      '--paths',
      'src/a',
      '--ticket-file',
      'ticket.md',
    );
    expect(added).toMatchObject({ code: 0 });
    const taskId = /^(t_\w+) \[draft\]/.exec(added.out)![1]!;

    expect((await team('task', 'queue', taskId)).out).toMatch(/\[queued\]/);
    // wait for the fake runs to finish (impl → verify → review → done)
    for (let i = 0; i < 50; i++) {
      const list = await team('--json', 'task', 'list');
      if ((JSON.parse(list.out) as Array<{ status: string }>)[0]?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const show = await team('task', 'show', taskId);
    expect(show.out).toMatch(new RegExp(`^${taskId} \\[done\\]`));
    expect(show.out).toMatch(/run r_\w+ impl impl_C deepseek-flash succeeded ok/);

    const receipt = await team('receipt', taskId);
    expect(receipt).toMatchObject({
      code: 0,
      out: expect.stringMatching(/review review_C gpt-sol: pass/),
    });

    // watch replays from the cursor and stops on abort
    const controller = new AbortController();
    const lines: string[] = [];
    const io = captureIo(() => connectLocal({ env }), {
      env,
      signal: controller.signal,
      stdout: (t) => {
        lines.push(t);
        if (lines.length === 3) controller.abort();
      },
    });
    expect(await runCli(['watch', '--after', '0'], io)).toBe(0);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['#1', '#2', '#3']);
    expect(lines[0]).toMatch(/recovery\.completed/); // service start
    expect(lines[1]).toMatch(/project\.created/);

    const opened = await team(
      'attention',
      'open',
      '--question',
      '要哪個？',
      '--option',
      'A',
      '--option',
      'B',
    );
    const attentionId = /^(a_\w+)/.exec(opened.out)![1]!;
    expect((await team('attention', 'list')).out).toContain(attentionId);
    expect((await team('attention', 'answer', attentionId, 'A')).out).toMatch(
      /answered\] 要哪個？/,
    );

    expect((await team('resume')).out).toContain('# 現況摘要');
    expect((await team('doctor')).code).toBe(0);
  });

  it('ask stores the message but the leader is not implemented yet (exit 2)', async () => {
    const ask = await team('ask', '你好');
    expect(ask.code).toBe(2);
    expect(ask.err).toMatch(/not_implemented/);
  });

  it('a business error exits 1; a stopped server exits 2', async () => {
    expect((await team('task', 'show', 't_999999')).code).toBe(1);
    await server.service.stop();
    const down = await team('status');
    expect(down.code).toBe(2);
    expect(down.err).toMatch(/not running/);
  });
});
