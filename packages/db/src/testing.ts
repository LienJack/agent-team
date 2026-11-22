import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from './migrate.js';

/** A fresh directory under the OS temp dir; `remove()` deletes it with every file in it. */
export function tempDir(prefix = 'agent-team-db-'): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A copy of the migrations folder in `dir` without migration `tag` and every later one: the
 * database of the build before that migration (upgrade tests).
 */
export function migrationsBefore(dir: string, tag: string): string {
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  if (cut < 0) throw new Error(`no migration ${tag}`);
  for (const entry of journal.entries.slice(cut)) rmSync(join(dir, `${entry.tag}.sql`));
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}
