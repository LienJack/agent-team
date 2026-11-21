import { StringDecoder } from 'node:string_decoder';

/**
 * Line-buffered UTF-8 decoder for child output: feed raw chunks, receive complete lines (without
 * the trailing `\n` / `\r\n`). Multi-byte characters split across chunks are kept intact.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let idx = this.pending.indexOf('\n');
    while (idx >= 0) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      idx = this.pending.indexOf('\n');
    }
  }

  /** Emit the last unterminated line, if any. */
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) {
      const line = this.pending;
      this.pending = '';
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
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
