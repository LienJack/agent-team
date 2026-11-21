import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The workspace root: the nearest ancestor of `from` holding pnpm-workspace.yaml. */
export function workspaceRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
    dir = parent;
  }
  return dir;
}

/**
 * Format `source` the way `pnpm format` would (root oxfmt + .oxfmtrc.json), so generated files
 * pass `format:check` and the drift check compares formatted text. `fileName` picks the parser.
 */
export function formatWithOxfmt(root: string, fileName: string, source: string): string {
  const bin = join(root, 'node_modules', '.bin', 'oxfmt');
  const result = spawnSync(
    bin,
    ['-c', join(root, '.oxfmtrc.json'), `--stdin-filepath=${fileName}`],
    { input: source, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`oxfmt failed (${result.status}): ${result.stderr || String(result.error)}`);
  }
  return result.stdout;
}
