import type { Logger } from '@agent-team/core';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

function plain(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  return value;
}

/**
 * JSON-lines logger (one object per line on `write`, normally stderr). Callers never pass secret
 * values in `fields` (AGENTS.md); the logger has no access to them either.
 */
export function createLogger(options: {
  write: (line: string) => void;
  level?: LogLevel;
  now?: () => Date;
}): Logger {
  const min = LEVELS.indexOf(options.level ?? 'info');
  const now = options.now ?? (() => new Date());
  const log =
    (level: LogLevel) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      if (LEVELS.indexOf(level) < min) return;
      const entry: Record<string, unknown> = { ts: now().toISOString(), level, msg: message };
      for (const [key, value] of Object.entries(fields)) entry[key] = plain(value);
      try {
        options.write(`${JSON.stringify(entry)}\n`);
      } catch {
        // logging must never break the service
      }
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
