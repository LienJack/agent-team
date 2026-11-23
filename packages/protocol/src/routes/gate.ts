import { createRoute } from '@hono/zod-openapi';
import {
  GateIdSchema,
  GateJobSchema,
  GateRequestSchema,
  GateStartResponseSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema } from '../common.js';

// The gate (spec §19; docs/adr/0026): verify and commit a worktree the service did not create.
// Humans only (the leader gets 403); jobs live in memory.

const tags = ['gate'];

export const startGate = createRoute({
  operationId: 'startGate',
  tags,
  method: 'post',
  path: '/api/gate',
  summary:
    'Start checking an outside worktree (owned paths, machine checks, then a service-side commit); 429 at gate.max_concurrent',
  request: { headers: MutationHeadersSchema, body: body(GateRequestSchema) },
  responses: {
    202: json(GateStartResponseSchema, 'The job started; poll GET /api/gate/{id}'),
    ...errors(429, 503),
  },
});

export const getGate = createRoute({
  operationId: 'getGate',
  tags,
  method: 'get',
  path: '/api/gate/{id}',
  summary: 'A gate job: running, or done with its verdict (kept 1 hour, lost on restart)',
  request: { params: idParam(GateIdSchema) },
  responses: { 200: json(GateJobSchema, 'The gate job'), ...errors(404) },
});

export const gateRoutes = { startGate, getGate };
