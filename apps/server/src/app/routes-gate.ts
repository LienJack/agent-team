import { TeamError } from '@agent-team/core';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { getGate, startGate } from '@agent-team/protocol';
import type { GateJobs } from '../gate/jobs.js';
import { ok, register } from './register.js';
import type { AppContext, AppEnv } from './types.js';

// The gate (spec §19): thin — the job table validates, limits and runs. The leader never gets
// here (route guard); the job table refuses it as well.

function jobs(ctx: AppContext): GateJobs {
  if (!ctx.gates) throw new TeamError('unavailable', 'the gate is not available in this service');
  return ctx.gates;
}

export function registerGateRoutes(app: OpenAPIHono<AppEnv>, ctx: AppContext): void {
  register(app, startGate, (c) => {
    const job = jobs(ctx).start(c.req.valid('json'), c.get('actor'));
    return { status: 202, body: { gate_id: job.gate_id, state: 'running' } };
  });

  register(app, getGate, (c) => ok(jobs(ctx).get(c.req.valid('param').id)));
}
