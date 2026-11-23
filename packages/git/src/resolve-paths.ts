import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonical, stripSlash } from './paths.js';

/**
 * Where each existing file of a worktree really lives, resolved through symlinks (the file itself
 * or a parent directory): repo-relative POSIX path, `null` when it resolves outside the worktree.
 * Files that do not exist (deleted) are omitted. Read-only (GitPort.resolvePaths, the gate).
 */
export function resolveWorktreePaths(
  worktreePath: string,
  files: readonly string[],
): Record<string, string | null> {
  const rootCanon = stripSlash(canonical(worktreePath));
  const out: Record<string, string | null> = {};
  for (const file of files) {
    const abs = join(worktreePath, file);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // deleted
    }
    let target: string;
    if (st.isSymbolicLink()) {
      // resolve the link (even a dangling one) from its real parent directory
      const parent = canonical(dirname(abs));
      target = canonical(resolve(parent, readlinkSync(abs)));
    } else {
      target = canonical(abs);
    }
    const rel = relative(rootCanon, target);
    out[file] =
      rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)
        ? null
        : rel.split(sep).join('/');
  }
  return out;
}
