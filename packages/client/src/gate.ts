import type { GateJob, GateStartBody, TeamClient } from './client.js';

// `team gate` and the MCP `gate_worktree` tool (spec §19): start a gate job, then poll
// GET /api/gate/{id} until it is done. The job keeps running on the server when the caller stops
// waiting (signal); GET /api/gate/{id} still answers for an hour after it ends.

export interface RunGateOptions {
  /** Poll interval (default 1000 ms). */
  pollMs?: number;
  /** Stop waiting (the job is not cancelled). */
  signal?: AbortSignal;
  /** Called once with the job id right after the job started. */
  onStarted?: (gateId: string) => void;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Start a gate job and wait for its verdict. */
export async function runGate(
  client: Pick<TeamClient, 'startGate' | 'getGate'>,
  body: GateStartBody,
  options: RunGateOptions = {},
): Promise<GateJob> {
  const started = await client.startGate(body);
  options.onStarted?.(started.gate_id);
  const signal = options.signal;
  for (;;) {
    const job = await client.getGate(started.gate_id, signal ? { signal } : {});
    if (job.state === 'done') return job;
    await pause(options.pollMs ?? 1000, signal);
  }
}
