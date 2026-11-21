import { createRoute } from '@hono/zod-openapi';
import {
  DoctorResponseSchema,
  EventsQuerySchema,
  QuotaResponseSchema,
  ResumeResponseSchema,
  RolesResponseSchema,
  RunIdSchema,
  RunLogQuerySchema,
  RunLogResponseSchema,
  StateResponseSchema,
} from '@agent-team/schema';
import { z } from 'zod';
import { errors, idParam, json } from '../common.js';

export const getState = createRoute({
  operationId: 'getState',
  tags: ['state'],
  method: 'get',
  path: '/api/state',
  summary: 'Board snapshot; continue live with GET /api/events?after=<last_seq>',
  responses: { 200: json(StateResponseSchema, 'Board snapshot'), ...errors() },
});

/** SSE event stream (spec §11). Not consumed through the typed client (see `subscribeEvents`). */
export const streamEvents = createRoute({
  operationId: 'streamEvents',
  tags: ['events'],
  method: 'get',
  path: '/api/events',
  summary: 'Server-sent events: replay after a seq cursor, then live',
  description: [
    'First frame: `{"type":"server.connected","last_seq":N,"ts":…}`.',
    'Then one frame per stored event (`id:` = seq, `data:` = the event record as JSON), first',
    'the events after the cursor (`after`, else `Last-Event-ID`, else only new events), then live.',
    'A comment line is sent as heartbeat every `sse.heartbeat_ms` (15 s). A client that falls',
    'behind by more than `sse.max_queue` events is disconnected and reconnects with its cursor.',
  ].join(' '),
  request: {
    query: EventsQuerySchema,
    headers: z.object({ 'Last-Event-ID': z.string().regex(/^\d+$/).optional() }),
  },
  responses: {
    200: { description: 'Event stream', content: { 'text/event-stream': { schema: z.string() } } },
    ...errors(),
  },
});

/** For humans only: never part of the leader's command set (spec §9). */
export const getRunLog = createRoute({
  operationId: 'getRunLog',
  tags: ['runs'],
  method: 'get',
  path: '/api/runs/{id}/log',
  summary: 'Last lines of a run’s raw event log',
  request: { params: idParam(RunIdSchema), query: RunLogQuerySchema },
  responses: { 200: json(RunLogResponseSchema, 'Log tail'), ...errors(404) },
});

export const getResume = createRoute({
  operationId: 'getResume',
  tags: ['system'],
  method: 'get',
  path: '/api/resume',
  summary: 'Model-free status summary for a new leader conversation',
  responses: { 200: json(ResumeResponseSchema, 'Markdown summary'), ...errors() },
});

/** The roles of config/models.json (what `reassign` accepts; disabled roles are refused). */
export const getRoles = createRoute({
  operationId: 'getRoles',
  tags: ['system'],
  method: 'get',
  path: '/api/roles',
  summary: 'Roles from config/models.json with their model alias, runner and slots',
  responses: { 200: json(RolesResponseSchema, 'Roles in config order'), ...errors() },
});

export const getQuota = createRoute({
  operationId: 'getQuota',
  tags: ['system'],
  method: 'get',
  path: '/api/quota',
  summary: 'Runner availability, cooldowns, circuit breakers and quota',
  responses: { 200: json(QuotaResponseSchema, 'Runner status'), ...errors() },
});

export const getDoctor = createRoute({
  operationId: 'getDoctor',
  tags: ['system'],
  method: 'get',
  path: '/api/doctor',
  summary: 'Runner probes and environment readiness (names and booleans only)',
  responses: { 200: json(DoctorResponseSchema, 'Doctor report'), ...errors() },
});

export const systemRoutes = {
  getState,
  streamEvents,
  getRunLog,
  getResume,
  getRoles,
  getQuota,
  getDoctor,
};
