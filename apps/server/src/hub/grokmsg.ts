import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, childEnv, findExecutable, runChild, type ChildResult } from '@agent-team/runners';

// The `grokmsg` CLI (Grok bridge mailbox; one JSON object per call, `watch` prints one line per
// new message). Always spawned with an argv array — a `$` in an option survives as is — with
// stdin closed; texts longer than FILE_THRESHOLD go through `--file` in a private temp file that
// is removed afterwards.

/** Non-secret grokmsg variables passed through (its mailbox and .env locations). */
const GROK_ENV_NAMES = ['GROKMSG_HOME', 'GROKMSG_ENV_FILE'];
export const FILE_THRESHOLD = 1000;
const CALL_TIMEOUT_MS = 60_000;

export interface GrokmsgRuntime {
  /** argv prefix of the executable (default: `grokmsg` on PATH). */
  command?: readonly string[];
  /** Environment the child allow-list is taken from (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
}

/** A message as `grokmsg read <id>` returns it (`{ ok, message }`). */
export interface GrokMessage {
  id: string;
  text: string;
  from?: string;
  reply_to?: string;
  choice?: string;
  question?: string;
}

export type ReplyStatus = 'working' | 'waiting_user' | 'done' | 'failed';

export class GrokmsgError extends Error {
  override name = 'GrokmsgError';
}

/** `GROKMSG id=<id> from=…` → id (the preview may contain anything, so only `id=` is read). */
export function parseWatchLine(line: string): string | undefined {
  const match = /^GROKMSG id=(\S+)/.exec(line.trim());
  return match?.[1];
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export class Grokmsg {
  constructor(private readonly runtime: GrokmsgRuntime = {}) {}

  env(): Record<string, string> {
    return childEnv(GROK_ENV_NAMES, {}, this.runtime.sourceEnv ?? process.env);
  }

  /** [executable, argv prefix], or undefined when grokmsg is not installed. */
  resolve(): [string, string[]] | undefined {
    const prefix = this.runtime.command;
    if (prefix && prefix.length > 0) return [prefix[0]!, prefix.slice(1)];
    const exe = findExecutable('grokmsg', this.env().PATH);
    return exe ? [exe, []] : undefined;
  }

  private async call(args: string[], text?: string): Promise<Record<string, unknown>> {
    const cmd = this.resolve();
    if (!cmd) throw new GrokmsgError('grokmsg is not installed (not on PATH)');
    let dir: string | undefined;
    try {
      const full = [...cmd[1], ...args];
      if (text !== undefined && text.length > FILE_THRESHOLD) {
        dir = await mkdtemp(join(tmpdir(), 'agent-team-grok-'));
        const file = join(dir, 'text.txt');
        await writeFile(file, text, { mode: 0o600 });
        full.push('--file', file);
      } else if (text !== undefined) {
        full.push('--text', text);
      }
      const out = await capture(cmd[0], full, {
        env: this.env(),
        cwd: tmpdir(),
        timeoutMs: CALL_TIMEOUT_MS,
      });
      let json: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '');
        if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
      } catch {
        json = undefined;
      }
      if (out.failure || out.exitCode !== 0 || json?.['ok'] !== true) {
        const notified = json?.['notified'] as { error?: unknown } | undefined;
        // `notify` records the notice even when the push fails; without a webhook a retry can
        // never succeed (and would hold up the outbox lane), so it counts as stored, not pushed
        if (args[0] === 'notify' && str(json?.['id']) && notified?.error === 'WEBHOOK_NOT_SET') {
          return json!;
        }
        const why =
          out.failure ?? str(json?.['error']) ?? str(notified?.error) ?? `exit ${out.exitCode}`;
        throw new GrokmsgError(`grokmsg ${args[0]} failed: ${why}`);
      }
      return json;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  async read(id: string): Promise<GrokMessage | undefined> {
    let json: Record<string, unknown>;
    try {
      json = await this.call(['read', id]);
    } catch {
      return undefined;
    }
    const m = json['message'];
    if (!m || typeof m !== 'object') return undefined;
    const r = m as Record<string, unknown>;
    const choice = r['choice'];
    return {
      id: str(r['id']) ?? id,
      text: str(r['text']) ?? '',
      ...(str(r['from']) ? { from: str(r['from'])! } : {}),
      ...(str(r['reply_to']) ? { reply_to: str(r['reply_to'])! } : {}),
      ...(choice !== undefined && choice !== null ? { choice: String(choice) } : {}),
      ...(str(r['question']) ? { question: str(r['question'])! } : {}),
    };
  }

  /**
   * `grokmsg reply <id> --status … [--question Q --option A …] --text|--file …`. Resolves with
   * whether Grok was pushed (`notified.ok`; false when the webhook is not set up), throws when
   * the reply itself was not stored.
   */
  async reply(
    id: string,
    input: { status: ReplyStatus; text: string; question?: string; options?: readonly string[] },
  ): Promise<{ pushed: boolean | undefined }> {
    const args = ['reply', id, '--status', input.status];
    if (input.options && input.options.length > 0) {
      if (input.question !== undefined) args.push('--question', input.question);
      for (const option of input.options) args.push('--option', option);
    }
    const json = await this.call(args, input.text);
    const notified = json['notified'] as { ok?: unknown } | undefined;
    return { pushed: typeof notified?.ok === 'boolean' ? notified.ok : undefined };
  }

  /**
   * `grokmsg notify`: starts a conversation in Grok; resolves with the notice id and whether it
   * was pushed (false: the webhook is not set up — stored under grokmsg's notices only).
   */
  async notify(text: string): Promise<{ id: string | undefined; pushed: boolean }> {
    const json = await this.call(['notify'], text);
    return { id: str(json['id']), pushed: json['ok'] === true };
  }

  /** Run `grokmsg watch` until it exits or `signal` aborts; one callback per message id. */
  watch(onId: (id: string) => void, signal: AbortSignal): Promise<ChildResult> {
    const cmd = this.resolve();
    if (!cmd) throw new GrokmsgError('grokmsg is not installed (not on PATH)');
    return runChild({
      command: cmd[0],
      args: [...cmd[1], 'watch'],
      cwd: tmpdir(),
      env: this.env(),
      timeoutMs: 2 ** 31 - 1,
      signal,
      killGraceMs: 2000,
      onStdoutLine: (line) => {
        const id = parseWatchLine(line);
        if (id !== undefined) onId(id);
      },
    });
  }
}
