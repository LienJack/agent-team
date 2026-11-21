import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of a standalone script next to the calling module: `<base>.js` when running from
 * `dist/`, `<base>.ts` when running from `src/` (Node ≥ 23.6 strips types natively).
 */
export function siblingScript(metaUrl: string, base: string): string {
  for (const ext of ['.js', '.ts']) {
    const path = fileURLToPath(new URL(`./${base}${ext}`, metaUrl));
    if (existsSync(path)) return path;
  }
  throw new Error(`script ${base} not found next to ${fileURLToPath(metaUrl)}`);
}
