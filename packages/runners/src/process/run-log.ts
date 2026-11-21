import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_LOG_FILES } from '@agent-team/schema';
import type { Redactor } from '../redact.js';

/**
 * The run's log directory (`DATA/runs/<run_id>/`): `prompt.md`, the raw event stream in
 * `events.jsonl` and the child's `stderr.log`. Every line is redacted before it is written;
 * stderr is line-buffered by the caller so a key split across chunks is still caught.
 */
export class RunLog {
  private events: WriteStream | undefined;
  private stderr: WriteStream | undefined;

  private constructor(
    readonly dir: string,
    private readonly redact: Redactor,
  ) {}

  static async open(dir: string, redact: Redactor): Promise<RunLog> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const log = new RunLog(dir, redact);
    log.events = createWriteStream(join(dir, RUN_LOG_FILES.events), { flags: 'a', mode: 0o600 });
    log.stderr = createWriteStream(join(dir, RUN_LOG_FILES.stderr), { flags: 'a', mode: 0o600 });
    // a failing log write must never crash the service; the run result still comes back
    log.events.on('error', () => {});
    log.stderr.on('error', () => {});
    return log;
  }

  path(file: string): string {
    return join(this.dir, file);
  }

  async writePrompt(prompt: string): Promise<void> {
    await writeFile(this.path(RUN_LOG_FILES.prompt), this.redact(prompt), { mode: 0o600 });
  }

  /** One raw stdout line (already a JSON object line or not) → events.jsonl. */
  event(line: string): void {
    this.events?.write(`${this.redact(line)}\n`);
  }

  /** A structured event produced by the runner itself (e.g. Codex SDK events). */
  eventObject(value: unknown): void {
    this.event(JSON.stringify(value));
  }

  stderrLine(line: string): void {
    this.stderr?.write(`${this.redact(line)}\n`);
  }

  async close(): Promise<void> {
    await Promise.all(
      [this.events, this.stderr].map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s || s.closed || s.destroyed) return resolve();
            s.end(() => resolve());
          }),
      ),
    );
  }
}
