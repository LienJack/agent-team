import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh directory under the OS temp dir; `remove()` deletes it with every file in it. */
export function tempDir(prefix = 'agent-team-db-'): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
