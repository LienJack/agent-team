import type { Actor, Clock, Engine, Logger, Store } from '@agent-team/core';
import type { DoctorResponse, ServiceConfig } from '@agent-team/schema';
import type { Leader } from '../leader/types.js';
import type { EventHub } from './sse.js';

/** Hono environment: who is calling (set by the auth middleware of each listener). */
export interface AppEnv {
  Variables: {
    /** Idempotency caller: `local`, or `lan:<session hash>`. Never a credential. */
    caller: string;
    actor: Actor;
  };
}

/** Everything the routes talk to; only ports and plain values (no adapters). */
export interface AppContext {
  engine: Engine;
  store: Store;
  clock: Clock;
  logger: Logger;
  service: ServiceConfig;
  /** Absolute DATA directory (run logs live under DATA/runs). */
  dataDir: string;
  leader: Leader;
  events: EventHub;
  doctor: () => Promise<DoctorResponse>;
  /** Directory with the built board (`index.html`), or undefined for the placeholder page. */
  webDist: string | undefined;
  /** Validate a new project's repository before it is stored (git can resolve the branch). */
  checkRepo?: (repoPath: string, baseBranch: string) => Promise<void>;
}
