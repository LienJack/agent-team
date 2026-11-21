// Real leader smoke (spec §14 冒煙, §9): the REAL claude CLI as the leader, everything else
// in-process fakes (runners) on a temp AGENT_TEAM_HOME, the real SQLite store and the real
// loopback listener. Gated by TEAM_SMOKE=1; spends a little subscription quota.
//
//   pnpm build && pnpm --filter @agent-team/server test:smoke
//   SMOKE_LEADER_MODEL=<alias in config/models.json>   default haiku
//
// Proves: the leader runs `team status` through its shim against this server and answers; the
// second message continues the same conversation (`--resume`); the shell surface of ADR 0012 —
// `team task list` and a heredoc `team task add` run, `ls`, `echo`, `pwd`, `cat`, `printenv` are
// refused; the leader actor gets 403 on a leader-forbidden route. Prints tokens per turn.
// The claude transcripts it leaves for the temp working directory are removed afterwards.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomIdGen } from '@agent-team/core';
import { createSqliteStore } from '@agent-team/db';
import { createGitPort } from '@agent-team/git';
import { createCheckExecutor, createRunnerRegistry } from '@agent-team/runners';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createEnvReader } from '../../src/env.js';
import { createLogger } from '../../src/logger.js';
import { createService, type Service } from '../../src/service.js';

const enabled = process.env['TEAM_SMOKE'] === '1';
const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const projects = join(homedir(), '.claude', 'projects');
const before = existsSync(projects) ? new Set(readdirSync(projects)) : new Set<string>();

let root: string | undefined;
let service: Service | undefined;
afterAll(async () => {
  await service?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  // transcripts of this run's temp working directory only (new project dirs mentioning it)
  if (existsSync(projects)) {
    for (const name of readdirSync(projects)) {
      if (!before.has(name) && name.includes('agent-team-leader-smoke')) {
        rmSync(join(projects, name), { recursive: true, force: true });
        process.stdout.write(`removed transcript dir ~/.claude/projects/${name}\n`);
      }
    }
  }
});

// oxlint-disable-next-line typescript/no-explicit-any
type Loose = any;

interface TurnLog {
  input: string;
  error: string | null;
  context_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  commands: number;
  denied: number;
}

describe.skipIf(!enabled)('smoke: the real leader conversation', () => {
  it('answers through `team status`, resumes, refuses other commands', async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-team-leader-smoke-'));
    const data = join(root, 'data');
    const config = join(root, 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'service.json'),
      JSON.stringify({
        local: { host: '127.0.0.1', port: 0 },
        lan: { enabled: false },
        grok: { enabled: false },
        paths: { worktree_root: join(root, 'worktrees') },
        engine: { tick_ms: 60_000 },
      }),
    );
    const models = JSON.parse(readFileSync(join(repo, 'config', 'models.json'), 'utf8'));
    models.roles.leader = {
      ...models.roles.leader,
      use: process.env['SMOKE_LEADER_MODEL'] ?? 'haiku',
      fallback: [],
    };
    writeFileSync(join(config, 'models.json'), JSON.stringify(models));
    const envFile = join(root, 'empty.env');
    writeFileSync(envFile, '');

    const processEnv = { AGENT_TEAM_HOME: data, AGENT_TEAM_CONFIG_DIR: config };
    const loaded = loadConfig({ env: processEnv, projectRoot: repo });
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => void lines.push(line) });
    const env = createEnvReader({ file: envFile, processEnv: {} });
    mkdirSync(data, { recursive: true });
    const store = createSqliteStore({ path: join(data, 'team.db') });
    const teamEntry = join(repo, 'apps', 'cli', 'dist', 'bin.js');
    expect(existsSync(teamEntry), 'run `pnpm build` first').toBe(true);

    service = createService({
      store,
      runners: createRunnerRegistry({ fake: true }),
      git: createGitPort({ worktreeRoot: loaded.worktreeRoot, author: loaded.service.git.author }),
      checks: createCheckExecutor({ allowUnsandboxed: true }),
      clock: { now: () => new Date() },
      ids: randomIdGen,
      config: loaded,
      env,
      logger,
      print: () => {},
      onClose: () => store.close(),
      leader: { enabled: true, teamEntry },
    });
    // something to report: one project, one draft task, one open question
    const project = service.engine.createProject({ name: 'demo', repo_path: join(root, 'repo') });
    service.engine.createTask({
      project_id: project.id,
      title: '登入頁加上記住我',
      tier: 'C',
      ticket_md: '# 登入頁加上記住我\n## 驗收標準\n- 測試通過',
      owned_paths: ['src/login/'],
    });
    const running = await service.start();
    const { token } = JSON.parse(readFileSync(running.listenerFile, 'utf8')) as { token: string };
    expect(service.leader.status()).toMatchObject({ available: true, state: 'idle' });

    const ask = async (text: string, id: string) => {
      const res = await fetch(`${running.localUrl}/api/leader/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, source: 'cli', client_msg_id: id }),
      });
      const body = (await res.json()) as { reply?: string; error?: unknown };
      const events = readFileSync(join(data, 'leader', 'turn', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, Loose>);
      const tools = events.flatMap((e) =>
        e.type === 'assistant'
          ? (e.message.content as Loose[])
              .filter((c) => c.type === 'tool_use')
              .map((c) => c.input.command as string)
          : [],
      );
      const results = events.flatMap((e) =>
        e.type === 'user' && Array.isArray(e.message.content)
          ? (e.message.content as Loose[])
              .filter((c) => c.type === 'tool_result')
              .map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)))
          : [],
      );
      const denied = (events.find((e) => e.type === 'result')?.permission_denials ?? []).map(
        (d: Loose) => d.tool_input?.command,
      );
      process.stdout.write(
        `\n>>> ${text}\n<<< ${res.status} ${body.reply ?? JSON.stringify(body.error)}\n`,
      );
      process.stdout.write(
        `    commands: ${JSON.stringify(tools)}\n    denied: ${JSON.stringify(denied)}\n`,
      );
      for (const r of results)
        process.stdout.write(`    result: ${r.slice(0, 300).replace(/\n/g, ' | ')}\n`);
      return { status: res.status, reply: body.reply ?? '', tools, results, denied };
    };

    const first = await ask('列出目前的任務狀態', 'smoke-1');
    expect(first.status).toBe(200);
    expect(first.tools.some((c) => /^team status\b/.test(c))).toBe(true);
    // the tool result is this server's answer (the draft task / project are in it)
    expect(first.results.join('\n')).toMatch(/tasks:|demo|登入頁/);
    expect(first.reply.length).toBeGreaterThan(0);

    const second = await ask('我上一則訊息問了你什麼？用一句話回答，不要執行任何指令。', 'smoke-2');
    expect(second.status).toBe(200);
    expect(second.reply).toMatch(/任務|狀態|status/i);

    const probe = [
      'team task list',
      "team task add --project demo --title 冒煙探測 --tier C --paths docs/ - <<'EOF'\n# 冒煙探測\n## 驗收標準\n- 無\nEOF",
      'ls /',
      'ls -la',
      'echo hello',
      'pwd',
      'cat /etc/hosts',
      'printenv',
      'team leader reset',
    ];
    const third = await ask(
      [
        '這是服務端的權限測試，請照做：用 Bash 工具「各自單獨呼叫一次」執行下列每一條指令（一次一條、不要合併、',
        '不要加前綴；被拒絕也沒關係，不要改用別的寫法重試），然後逐條回報結果：',
        ...probe.map((c, i) => `${i + 1}. ${c}`),
      ].join('\n'),
      'smoke-3',
    );
    expect(third.status).toBe(200);
    expect(third.reply).not.toContain(token);
    // ADR 0012: the heredoc form of `team task add` runs (prefix rule `Bash(team task:*)`)
    expect(store.tasks.list().some((t) => t.title === '冒煙探測')).toBe(true);
    const ran = ['ls -la', 'echo hello', 'pwd', 'cat /etc/hosts', 'printenv'].filter((c) =>
      third.tools.includes(c),
    );
    expect(ran.filter((c) => !third.denied.includes(c))).toEqual([]);
    const lsRefused = third.denied.some((c: string) => c?.startsWith('ls /'));
    const resetForbidden = third.results.some((r) => /not available to the leader/.test(r));
    process.stdout.write(
      `    ls refused: ${lsRefused}; reset 403 via the leader's team: ${resetForbidden}\n`,
    );
    // anything the model ran outside `team` must have been refused
    for (const command of third.tools.filter((c) => !c.startsWith('team '))) {
      expect(third.denied).toContain(command);
    }

    // the shim itself: `team` as the leader actor reaches this server and gets the 403
    const shim = join(data, 'leader', 'bin', 'team');
    // (async: the server runs in this process, a synchronous spawn would block it)
    const direct = await new Promise<{ status: number | null; stderr: string }>((done) => {
      execFile(
        shim,
        ['leader', 'reset'],
        { env: { PATH: process.env['PATH'] ?? '' }, timeout: 30_000 },
        (err, _out, stderr) =>
          done({ status: err ? ((err as { code?: number }).code ?? null) : 0, stderr }),
      );
    });
    process.stdout.write(
      `    shim \`team leader reset\`: exit ${direct.status}: ${direct.stderr.trim()}\n`,
    );
    expect(direct.status).toBe(1);
    expect(direct.stderr).toMatch(/not available to the leader/);

    const turns = lines
      .map((l) => JSON.parse(l) as { msg: string } & TurnLog)
      .filter((l) => l.msg === 'leader turn');
    process.stdout.write('\nper-turn usage:\n');
    for (const t of turns) {
      process.stdout.write(
        `  ${t.input}: context ${t.context_tokens}, input ${t.input_tokens}, cache_read ${t.cache_read_tokens}, cache_write ${t.cache_write_tokens}, output ${t.output_tokens}, cost $${t.cost_usd}, commands ${t.commands}, denied ${t.denied}, error ${t.error}\n`,
      );
    }
    expect(turns.length).toBeGreaterThanOrEqual(3);
    const state = JSON.parse(store.kv.get('leader:conversation') ?? '{}') as { started?: boolean };
    expect(state.started).toBe(true);
  });
});
