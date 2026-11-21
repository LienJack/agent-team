// Extracting the worker's JSON receipt from model text (dsh has no schema enforcement; claude
// and codex fall back to it when the structured field is missing).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** End index (exclusive) of the balanced `{…}` starting at `start`, or -1. Respects strings. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The first complete JSON object in `text` (spec §7 dsh): the whole text when it parses as an
 * object, otherwise the first balanced `{…}` that parses. Undefined when there is none.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const whole: unknown = JSON.parse(trimmed);
      if (isPlainObject(whole)) return whole;
    } catch {
      // fall through to scanning
    }
  }
  let from = text.indexOf('{');
  while (from >= 0) {
    const end = balancedEnd(text, from);
    if (end < 0) return undefined;
    try {
      const value: unknown = JSON.parse(text.slice(from, end));
      if (isPlainObject(value)) return value;
    } catch {
      // not JSON; try the next opening brace
    }
    from = text.indexOf('{', from + 1);
  }
  return undefined;
}

export { isPlainObject };
