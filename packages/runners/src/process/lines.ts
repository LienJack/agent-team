import { StringDecoder } from 'node:string_decoder';

/** Longest line passed on (1 Mi characters); the rest of a longer line is dropped (L9d). */
export const MAX_LINE_CHARS = 1024 * 1024;

/**
 * Line-buffered UTF-8 decoder for child output: feed raw chunks, receive complete lines (without
 * the trailing `\n` / `\r\n`). Multi-byte characters split across chunks are kept intact. A line
 * longer than `maxChars` is emitted once, cut at `maxChars` with a `…[line truncated: N more
 * characters]` marker, and the rest of it is skipped up to the next newline — memory stays
 * bounded and parsing continues with the next line.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  /** Characters of an over-long line skipped so far (its head was already emitted). */
  private skipped = -1;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxChars = MAX_LINE_CHARS,
  ) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let idx = this.pending.indexOf('\n');
    while (idx >= 0) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      if (this.skipped >= 0) this.finishSkipped(line.length);
      else this.emit(line);
      idx = this.pending.indexOf('\n');
    }
    if (this.skipped >= 0) {
      this.skipped += this.pending.length;
      this.pending = '';
    } else if (this.pending.length > this.maxChars) {
      this.head = this.pending.slice(0, this.maxChars);
      this.skipped = this.pending.length - this.maxChars;
      this.pending = '';
    }
  }

  private head = '';

  private finishSkipped(rest: number): void {
    const skipped = this.skipped + rest;
    this.skipped = -1;
    this.onLine(`${this.head}…[line truncated: ${skipped} more characters]`);
    this.head = '';
  }

  private emit(line: string): void {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean.length > this.maxChars) {
      this.onLine(
        `${clean.slice(0, this.maxChars)}…[line truncated: ${clean.length - this.maxChars} more characters]`,
      );
    } else {
      this.onLine(clean);
    }
  }

  /** Emit the last unterminated line, if any. */
  end(): void {
    this.pending += this.decoder.end();
    if (this.skipped >= 0) {
      this.finishSkipped(this.pending.length);
      this.pending = '';
      return;
    }
    if (this.pending.length > 0) {
      const line = this.pending;
      this.pending = '';
      this.emit(line);
    }
  }
}

/** Parse one JSONL line into an object; undefined for blank, non-JSON or non-object lines. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
