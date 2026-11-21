import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeStream } from './claude/stream.js';
import { runClaudeText } from './claude/text.js';
import { CodexStream } from './codex/stream.js';
import { DshStream } from './dsh/stream.js';
import { childEnv } from './process/env.js';
import type { ChildResult } from './process/spawn.js';
import { tempDir } from './test-support.js';
import { writeScenario } from './testing/index.js';

// Rate limits and auth failures are told from structured fields (rate_limit_event, the
// assistant event's `error`, the result's `api_error_status`) and the CLI's own text — never
// from what the model wrote: a worker that prints "usage limit reached" must not cool a runner
// down or get its attempt refunded. Results are accepted only after the agent's success signal.

const exit0: ChildResult = { reason: 'exit', exitCode: 0, signal: null, durationMs: 1 };
const SESSION = '00000000-0000-4000-8000-000000000001';

const init = { type: 'system', subtype: 'init', session_id: SESSION };
const modelSays = (text: string) => ({
  type: 'assistant',
  message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text }] },
  session_id: SESSION,
});
const errorResult = (result: string, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  session_id: SESSION,
  result,
  ...extra,
});

function claude(events: Array<Record<string, unknown>>, stderrTail: string[] = []) {
  const p = new ClaudeStream();
  for (const e of events) p.line(e);
  return p.finish({ child: exit0, stderrTail });
}

describe('runners: claude classification sources', () => {
  it('does not take a rate limit or auth failure from model-authored text', () => {
    const text = 'Claude AI usage limit reached|1763701200. Not logged in · Please run /login';
    const r = claude([init, modelSays(text), errorResult(text)]);
    expect(r.error?.kind).toBe('crash');
    expect(r.quota).toBeUndefined();
  });

  it('uses the structured error of a synthetic assistant message and api_error_status', () => {
    const synthetic = {
      type: 'assistant',
      error: 'rate_limit',
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
      session_id: SESSION,
    };
    expect(
      claude([init, modelSays('working'), synthetic, errorResult('API Error')]).error?.kind,
    ).toBe('rate_limit');
    const auth = claude([
      init,
      modelSays('working'),
      errorResult('API Error: 401', { api_error_status: 401 }),
    ]);
    expect(auth.error?.kind).toBe('auth');
    const limited = claude([
      init,
      modelSays('working'),
      errorResult('API Error: 429', { api_error_status: 429 }),
    ]);
    expect(limited.error?.kind).toBe('rate_limit');
  });

  it('still reads the CLI-authored result text when the model never answered', () => {
    expect(claude([init, errorResult('Not logged in · Please run /login')]).error?.kind).toBe(
      'auth',
    );
  });

  it('classifies stderr (the CLI, not the model)', () => {
    const r = claude([init, modelSays('x'), errorResult('x')], ['Error: 429 Too Many Requests']);
    expect(r.error?.kind).toBe('rate_limit');
  });
});

describe('runners: claude text (leader) classification sources', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  async function run(events: Array<Record<string, unknown>>) {
    const s = await writeScenario(t.dir, { steps: events.map((out) => ({ out })) });
    const [command, ...prefix] = s.command;
    return runClaudeText({
      command: command!,
      args: [...prefix, '-p'],
      cwd: t.dir,
      env: childEnv(),
      prompt: 'x',
      timeoutMs: 10_000,
      logDir: join(t.dir, 'log'),
    });
  }

  it('ignores model-authored text and uses api_error_status', async () => {
    const text = 'You have hit your usage limit; token expired, please run /login';
    expect((await run([init, modelSays(text), errorResult(text)])).error?.kind).toBe('crash');
    const auth = await run([init, modelSays('ok'), errorResult('x', { api_error_status: 403 })]);
    expect(auth.error?.kind).toBe('auth');
    expect((await run([init, errorResult('Not logged in · Please run /login')])).error?.kind).toBe(
      'auth',
    );
  });
});

describe('runners: codex accepts the final only after turn.completed', () => {
  const message = (text: string) => ({
    type: 'item.completed',
    item: { id: 'i', type: 'agent_message', text },
  });
  const receipt = '{"dispatch_id":"d_1","verdict":"pass","summary":"ok","findings":[]}';

  it('refuses an agent_message whose turn never completed', () => {
    const s = new CodexStream();
    s.event({ type: 'thread.started', thread_id: 't' });
    s.event({ type: 'turn.started' });
    s.event(message(receipt));
    const r = s.finish();
    expect(r.final).toBeUndefined();
    expect(r.error?.kind).toBe('crash');
    expect(r.error?.message).toMatch(/turn\.completed/);
  });

  it('accepts it after turn.completed', () => {
    const s = new CodexStream();
    s.event({ type: 'thread.started', thread_id: 't' });
    s.event(message(receipt));
    s.event({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    expect(s.finish().error).toBeUndefined();
  });
});

describe('runners: dsh accepts final only after a successful turn', () => {
  const receipt =
    '{"dispatch_id":"d_1","status":"done","summary":"ok","files_changed":[],"checks":[],"needs_leader":""}';
  const parse = (events: Array<Record<string, unknown>>) => {
    const p = new DshStream();
    for (const e of events) p.line(e);
    return p.finish({ child: exit0, stderrTail: [] });
  };
  const session = { type: 'session', sessionId: 'session-1' };
  const turnEnd = (kind: string) => ({
    type: 'status',
    phase: 'turn_end',
    turn: 1,
    reason: { kind },
  });

  it('accepts final after turn_end completed', () => {
    expect(parse([session, turnEnd('completed'), { type: 'final', text: receipt }]).error).toBe(
      undefined,
    );
  });

  it('refuses final without any turn_end (crash) or after a non-success turn (bad_output)', () => {
    const none = parse([session, { type: 'final', text: receipt }]);
    expect(none.final).toBeUndefined();
    expect(none.error?.kind).toBe('crash');
    const cut = parse([session, turnEnd('max_steps'), { type: 'final', text: receipt }]);
    expect(cut.final).toBeUndefined();
    expect(cut.error?.kind).toBe('bad_output');
    expect(cut.error?.message).toMatch(/max_steps/);
  });

  it('does not classify model text in final as a rate limit', () => {
    const r = parse([
      session,
      turnEnd('completed'),
      { type: 'final', text: 'rate limit reached, 429 too many requests' },
    ]);
    expect(r.error?.kind).toBe('bad_output');
  });
});
