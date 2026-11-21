import type { TeamClient } from '@agent-team/client';

/** Everything a command touches outside the process (injected so tests use fakes). */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Read all of stdin (`team task add … -`). */
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  /** Working directory (relative repo paths are resolved against it). */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** A client for the local listener (reads listener.json). */
  connect(): Promise<TeamClient>;
  /** `team serve`: run the server in the foreground; resolves with its exit code. */
  serve(): Promise<number>;
  /** Aborted on Ctrl-C (`team watch` stops cleanly). */
  signal?: AbortSignal;
  /** Client-chosen message id for `team ask` (default: random UUID). */
  newMessageId?: () => string;
}

/** A usage problem found by a command itself (exit code 2). */
export class UsageError extends Error {
  override name = 'UsageError';
}
