// Real-CLI smoke tests (spec §14 冒煙): one trivial writable run per runner with the cheapest
// model, gated by TEAM_SMOKE=1. They spend real quota/money; never run them in CI.
//
//   TEAM_SMOKE=1 pnpm --filter @agent-team/runners test:smoke
//   SMOKE_ONLY=claude|codex|dsh   run one runner
//   SMOKE_KEEP_DIR=<dir>          keep the run logs (events.jsonl…) there for fixture work
//
// dsh runs only when OPENROUTER_API_KEY is already in the environment.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReceipt, receiptJsonSchema, type RunResult, type RunSpec } from '@agent-team/schema';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeRunner } from '../../src/claude/runner.js';
import { CodexRunner } from '../../src/codex/runner.js';
import { DshRunner } from '../../src/dsh/runner.js';

const enabled = process.env.TEAM_SMOKE === '1';
const only = process.env.SMOKE_ONLY;
const want = (name: string) => enabled && (only === undefined || only === name);

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function spec(name: string, model: string, effort?: RunSpec['effort']): RunSpec {
  const dir = mkdtempSync(join(tmpdir(), `agent-team-smoke-${name}-`));
  created.push(dir);
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const keep = process.env.SMOKE_KEEP_DIR;
  const dispatchId = `d_smoke${name}01`;
  return {
    dispatchId,
    cwd,
    prompt: [
      'Create a file named hello.txt in the current directory containing exactly the word hi.',
      'Do not run git. Then answer with only the JSON receipt:',
      `dispatch_id "${dispatchId}", status "done", a one-line summary, files_changed ["hello.txt"],`,
      'checks [], needs_leader "".',
    ].join('\n'),
    schema: receiptJsonSchema('impl'),
    model,
    ...(effort === undefined ? {} : { effort }),
    writable: true,
    logDir: keep ? join(keep, name) : join(dir, 'log'),
    timeoutMs: 300_000,
  };
}

function report(name: string, s: RunSpec, r: RunResult): void {
  process.stdout.write(
    `[smoke ${name}] error=${r.error ? `${r.error.kind}: ${r.error.message}` : 'none'} usage=${JSON.stringify(r.usage ?? null)} cost=${r.costUsd ?? 'n/a'} quota=${JSON.stringify(r.quota ?? null)} session=${r.sessionRef ?? 'n/a'} cwd=${s.cwd}\n`,
  );
}

function expectWorked(s: RunSpec, r: RunResult): void {
  expect(r.error).toBeUndefined();
  const parsed = parseReceipt('impl', r.final);
  expect(parsed.ok).toBe(true);
  expect(parsed.ok && parsed.receipt.dispatch_id).toBe(s.dispatchId);
  expect(existsSync(join(s.cwd, 'hello.txt'))).toBe(true);
  expect(readFileSync(join(s.cwd, 'hello.txt'), 'utf8').trim()).toBe('hi');
  expect(r.usage).toBeDefined();
}

describe('smoke: real runners', () => {
  it.skipIf(!want('claude'))('claude -p writes a file and returns a receipt', async () => {
    const runner = new ClaudeRunner();
    const caps = await runner.probe();
    process.stdout.write(`[smoke claude] probe ${JSON.stringify(caps)}\n`);
    expect(caps.available).toBe(true);
    const s = spec('claude', 'claude-haiku-5-5', 'low');
    const r = await runner.run(s, new AbortController().signal);
    report('claude', s, r);
    expectWorked(s, r);
  });

  it.skipIf(!want('codex'))('codex (SDK) writes a file and returns a receipt', async () => {
    const runner = new CodexRunner();
    const caps = await runner.probe();
    process.stdout.write(`[smoke codex] probe ${JSON.stringify(caps)}\n`);
    expect(caps.available).toBe(true);
    const s = spec('codex', 'gpt-6.1-terra', 'low');
    const r = await runner.run(s, new AbortController().signal);
    report('codex', s, r);
    expectWorked(s, r);
  });

  it.skipIf(!want('dsh') || !process.env.OPENROUTER_API_KEY)(
    'dsh headless writes a file and returns a receipt',
    async () => {
      // Smoke only: the runners package has no key proxy (apps/server owns it, docs/adr/0020),
      // so this lease hands the tester's own key straight to dsh and points it at OpenRouter.
      // The service never does this; its dsh runs get a run token for the proxy.
      const key = process.env.OPENROUTER_API_KEY!;
      const runner = new DshRunner({
        keys: {
          hasKey: () => true,
          open: () => ({
            token: key,
            baseUrl: 'https://openrouter.ai/api/v1',
            port: 443,
            revoke: () => {},
          }),
        },
      });
      const caps = await runner.probe();
      expect(caps.available).toBe(true);
      const s = spec('dsh', 'deepseek/deepseek-v4.1-flash');
      const r = await runner.run(s, new AbortController().signal);
      report('dsh', s, r);
      expectWorked(s, r);
    },
  );
});
