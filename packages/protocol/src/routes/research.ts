import { createRoute } from '@hono/zod-openapi';
import {
  ResearchCreateRequestSchema,
  ResearchDetailResponseSchema,
  TaskIdSchema,
  TaskResponseSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema } from '../common.js';

// The research stage (spec §17): research tasks are tasks (listed, queued, cancelled and retried
// through the task routes); these two create one and show its result.

const tags = ['research'];

export const createResearch = createRoute({
  operationId: 'createResearch',
  tags,
  method: 'post',
  path: '/api/research',
  summary: 'Create a research task (draft, or queued with `queue: true`); 409 when research is off',
  request: { headers: MutationHeadersSchema, body: body(ResearchCreateRequestSchema) },
  responses: { 201: json(TaskResponseSchema, 'The created research task'), ...errors(404, 409) },
});

export const getResearch = createRoute({
  operationId: 'getResearch',
  tags,
  method: 'get',
  path: '/api/research/{id}',
  summary:
    'A research task and the receipt of its last accepted run (links not verified by the service)',
  request: { params: idParam(TaskIdSchema) },
  responses: { 200: json(ResearchDetailResponseSchema, 'Research result'), ...errors(404) },
});

export const researchRoutes = { createResearch, getResearch };
