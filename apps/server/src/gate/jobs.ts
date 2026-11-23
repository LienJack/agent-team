import {
  errorMessage,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnavailableError,
  type Actor,
  type CheckExecutor,
  type Clock,
  type Engine,
  type IdGen,
  type Logger,
  type Store,
} from '@agent-team/core';
import type { GateGit } from '@agent-team/git';
import { gateLogDir, GateRequestSchema, type GateJob, type GateRequest } from '@agent-team/schema';
import { runGate } from './run-gate.js';

// Gate jobs (spec §19 step 6): in memory only — a restart loses them and the caller runs the
// gate again (it is idempotent). At most `gate.max_concurrent` run at once (one more is 429);
// finished jobs are kept for an hour. Each finished job writes one `gate.completed` event.

/** How long a finished job stays readable. */
export const GATE_RETENTION_MS = 60 * 60 * 1000;

export interface GateJobsDeps {
  engine: Pick<Engine, 'recordGateCompleted'>;
  store: Pick<Store, 'projects'>;
  clock: Clock;
  ids: IdGen;
  git: GateGit;
  checks: CheckExecutor;
  dataDir: string;
  maxConcurrent: number;
  checkTimeoutMs: number;
  logger: Logger;
}

export interface GateJobs {
  /** Validate and start a job (humans only); throws 429 `too_many_requests` at the limit. */
  start(body: GateRequest, actor: Actor): GateJob;
  /** A running or finished job; 404 when unknown, expired or lost in a restart. */
  get(id: string): GateJob;
  /** Settles when every running job has ended (tests). */
  idle(): Promise<void>;
  /** Abort running checks and wait for the jobs to end (service stop). */
  stop(): Promise<void>;
}

export function createGateJobs(deps: GateJobsDeps): GateJobs {
  const jobs = new Map<string, GateJob>();
  const running = new Map<string, Promise<void>>();
  const abort = new AbortController();
  const now = () => deps.clock.now();

  function prune(): void {
    const cutoff = now().getTime() - GATE_RETENTION_MS;
    for (const [id, job] of jobs) {
      if (job.ended_at !== undefined && Date.parse(job.ended_at) < cutoff) jobs.delete(id);
    }
  }

  async function execute(job: GateJob, req: ReturnType<typeof GateRequestSchema.parse>) {
    let done: Partial<GateJob>;
    try {
      done = await runGate(
        {
          project: deps.store.projects.get(req.project_id),
          projectId: req.project_id,
          worktreePath: req.worktree_path,
          baseSha: req.base_sha,
          ownedPaths: req.owned_paths,
          commitMessage: req.commit_message,
          commit: req.commit,
        },
        {
          git: deps.git,
          checks: deps.checks,
          logDir: gateLogDir(deps.dataDir, job.gate_id),
          checkTimeoutMs: deps.checkTimeoutMs,
          signal: abort.signal,
        },
      );
    } catch (err) {
      done = { verdict: 'rejected', reasons: [`gate error: ${errorMessage(err)}`] };
    }
    Object.assign(job, done, { state: 'done', ended_at: now().toISOString() });
    const verdict = job.verdict ?? 'rejected';
    try {
      deps.engine.recordGateCompleted({
        gate_id: job.gate_id,
        project_id: job.project_id,
        verdict,
      });
    } catch (err) {
      deps.logger.warn('gate event not written', { error: errorMessage(err) });
    }
    deps.logger.info('gate completed', {
      gate_id: job.gate_id,
      project_id: job.project_id,
      verdict,
      committed: job.committed,
    });
  }

  return {
    start(body, actor) {
      if (actor.kind === 'leader') {
        throw new ForbiddenError(
          'the gate is for humans only',
          'a person (or their T3 Code session) runs `team gate`',
        );
      }
      if (abort.signal.aborted) throw new UnavailableError('the service is stopping');
      const req = GateRequestSchema.parse(body);
      prune();
      if (running.size >= deps.maxConcurrent) {
        throw new TooManyRequestsError(
          `${running.size} gate job(s) already running (gate.max_concurrent = ${deps.maxConcurrent})`,
          'wait for one to finish (GET /api/gate/{id}) and try again',
        );
      }
      const job: GateJob = {
        gate_id: deps.ids.newId('gate'),
        project_id: req.project_id,
        worktree_path: req.worktree_path,
        state: 'running',
        reasons: [],
        files_changed: [],
        out_of_scope: [],
        checks: [],
        committed: false,
        started_at: now().toISOString(),
      };
      jobs.set(job.gate_id, job);
      const task = execute(job, req).finally(() => running.delete(job.gate_id));
      running.set(job.gate_id, task);
      return { ...job };
    },

    get(id) {
      prune();
      const job = jobs.get(id);
      if (!job) {
        throw new NotFoundError(
          'gate job',
          id,
          'jobs live in memory for an hour after they finish and are lost on a restart; run the gate again (it is idempotent)',
        );
      }
      return structuredClone(job);
    },

    async idle() {
      await Promise.all(running.values());
    },

    async stop() {
      abort.abort();
      await Promise.all(running.values());
    },
  };
}
