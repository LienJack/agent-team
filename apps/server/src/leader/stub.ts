import { TeamError } from '@agent-team/core';
import { resumeBrief } from './resume.js';
import type { Leader, LeaderDeps } from './types.js';

/**
 * Phase 2 leader: no conversation yet. Messages are still stored (the route records them before
 * calling `handleMessage`), `resumeBrief()` is the real model-free summary, and the reply is a
 * `not_implemented` error (HTTP 501).
 */
export function createLeader(deps: LeaderDeps): Leader {
  return {
    status: () => ({ state: 'offline', last_activity_at: null }),
    notify: () => {
      // events stay in the durable event table; the phase 3 leader reads them from its cursor
    },
    handleMessage: async () => {
      throw new TeamError(
        'not_implemented',
        'not_implemented: the leader conversation is not available yet; the message was stored',
        'use `team task …` / `team attention …` meanwhile',
      );
    },
    resumeBrief: () => resumeBrief(deps),
    start: async () => {},
    stop: async () => {},
  };
}
