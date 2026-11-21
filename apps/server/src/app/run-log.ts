import { open } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { DATA_LAYOUT, RUN_LOG_FILES, type Run } from '@agent-team/schema';

/** Bytes read from the end of a log file at most (a tail never needs the whole file). */
const MAX_TAIL_BYTES = 1024 * 1024;

async function tailFile(
  path: string,
  lines: number,
): Promise<{ lines: string[]; truncated: boolean } | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let all = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) all = all.slice(1); // first line is partial
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    return { lines: all.slice(-lines), truncated: start > 0 || all.length > lines };
  } finally {
    await handle.close();
  }
}

/**
 * GET /api/runs/:id/log (for humans): the last `tail` lines of the run's raw agent event log
 * (`events.jsonl`), or of `stderr.log` when there is no event log. Runners mask secrets before
 * writing. Only directories under DATA/runs are read.
 */
export async function readRunLog(
  run: Run,
  dataDir: string,
  tail: number,
): Promise<{ run_id: string; lines: string[]; truncated: boolean }> {
  const runsRoot = resolve(dataDir, DATA_LAYOUT.runs);
  const dir = resolve(run.log_dir);
  const inside = !relative(runsRoot, dir).startsWith('..') && dir.startsWith(runsRoot + sep);
  if (inside) {
    for (const file of [RUN_LOG_FILES.events, RUN_LOG_FILES.stderr]) {
      const found = await tailFile(join(dir, file), tail);
      if (found) return { run_id: run.id, ...found };
    }
  }
  return { run_id: run.id, lines: [], truncated: false };
}
