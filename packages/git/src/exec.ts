import { spawn } from 'node:child_process';

// Running git: argv arrays only (no shell), stdin closed, an allow-listed environment with every
// GIT_* override scrubbed (an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would make git
// operate on the wrong repository), no prompts, C locale for parseable messages, a timeout.
//
// Every service-side git command runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false`
// (docs/adr/0016): worktrees are written by workers, and a hooksPath inside the working tree
// (husky's `.husky/_`) or a planted hook would otherwise execute worker code as the service. The
// service never talks to a remote, so no SSH agent socket is passed either.

const PASS_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
] as const;

/** Prepended to every git invocation of the service (docs/adr/0016). */
export const SERVICE_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** The environment for git children. `extra` (e.g. author identity) is applied last. */
export function gitEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_ENV) {
    const v = source[name];
    if (v !== undefined && v !== '') env[name] = v;
  }
  env.PATH ??= FALLBACK_PATH;
  env.LC_ALL = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = 'true';
  env.GIT_PAGER = 'cat';
  return { ...env, ...extra };
}

/** Names of variables `gitEnv` never passes through, for tests and diagnostics. */
export function isScrubbedGitVar(name: string): boolean {
  return (
    name.startsWith('GIT_') && !['GIT_TERMINAL_PROMPT', 'GIT_EDITOR', 'GIT_PAGER'].includes(name)
  );
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
}

export interface GitRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Resolve (instead of throwing) for these exit codes, e.g. `[1]` for `diff --quiet`. */
  okCodes?: number[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Run `git <args>`; throws GitError on a non-zero exit (unless listed in okCodes). */
export function git(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SERVICE_GIT_CONFIG, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new GitError(`cannot run git: ${e.message}`, args, null, ''));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      const result = { stdout: Buffer.concat(out), stderr, exitCode: code };
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) return resolve(result);
      const what = timedOut ? 'timed out' : `exited ${code}`;
      const detail = stderr.trim().split('\n').slice(-3).join(' | ');
      reject(
        new GitError(`git ${args.slice(0, 3).join(' ')} ${what}: ${detail}`, args, code, stderr),
      );
    });
  });
}

const LOCK_RE = /index\.lock|\.lock': File exists|Unable to create '.*\.lock'|Another git process/i;

/** Retry `fn` while git reports a held lock (index.lock, ref locks): up to 5 retries. */
export async function withLockRetry<T>(
  fn: () => Promise<T>,
  retries = 5,
  baseMs = 200,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const locked = e instanceof GitError && LOCK_RE.test(e.stderr);
      if (!locked || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
    }
  }
}
