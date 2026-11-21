import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage, type Engine, type Logger, type Store } from '@agent-team/core';
import { RUN_LOG_FILES } from '@agent-team/schema';

// "Run log advanced" events (spec §13 即時: the drawer's log tail follows a live run). Runners
// append to DATA/runs/<run_id>/events.jsonl; this watcher stats the logs of live runs every
// `intervalMs` and records one `run.log_advanced` event (run id + byte size) per run whose log
// grew — so at most one event per run per interval, however fast the agent writes.

/** Default and minimum spacing of two log events of the same run. */
export const RUN_LOG_EVENT_INTERVAL_MS = 2000;

export interface RunLogWatcher {
  /** One pass (the timer calls it; tests call it directly). */
  poll(): Promise<void>;
  stop(): void;
}

/** Size of the log the tail endpoint reads: events.jsonl, else stderr.log; undefined = none. */
async function logSize(logDir: string): Promise<number | undefined> {
  for (const file of [RUN_LOG_FILES.events, RUN_LOG_FILES.stderr]) {
    try {
      return (await stat(join(logDir, file))).size;
    } catch {
      // not written (yet)
    }
  }
  return undefined;
}

export function watchRunLogs(deps: {
  store: Store;
  engine: Engine;
  logger: Logger;
  intervalMs?: number;
  /** false = no timer (tests drive `poll`). */
  timer?: boolean;
}): RunLogWatcher {
  const intervalMs = Math.max(RUN_LOG_EVENT_INTERVAL_MS, deps.intervalMs ?? 0);
  const sizes = new Map<string, number>();
  let polling: Promise<void> | undefined;
  let stopped = false;

  async function pass(): Promise<void> {
    const live = deps.store.runs.list({ states: ['starting', 'running'] });
    const ids = new Set(live.map((r) => r.id));
    for (const id of sizes.keys()) if (!ids.has(id)) sizes.delete(id);
    for (const run of live) {
      const size = await logSize(run.log_dir);
      if (stopped || size === undefined || size <= (sizes.get(run.id) ?? 0)) continue;
      sizes.set(run.id, size);
      deps.engine.recordRunLog(run.id, size);
    }
  }

  const poll = (): Promise<void> => {
    // one pass at a time: a slow disk never stacks passes (and so never doubles events)
    polling ??= pass()
      .catch((err: unknown) =>
        deps.logger.warn('run log watch failed', { error: errorMessage(err) }),
      )
      .finally(() => {
        polling = undefined;
      });
    return polling;
  };

  const timer = deps.timer === false ? undefined : setInterval(() => void poll(), intervalMs);
  timer?.unref();
  return {
    poll,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
