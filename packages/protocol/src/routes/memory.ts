import { createRoute } from '@hono/zod-openapi';
import {
  MemoryAddRequestSchema,
  MemoryAddResponseSchema,
  MemoryListQuerySchema,
  MemoryListResponseSchema,
  MemoryParamsSchema,
  MemoryRemoveResponseSchema,
  MemorySearchQuerySchema,
  MemorySearchResponseSchema,
  ProjectIdSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema } from '../common.js';

// Project memory (spec §18; docs/adr/0023). 409 while `memory.enabled` is false, 503 when MemOS
// is unavailable. The leader may search; listing, adding and deleting are for humans.

const tags = ['memory'];
const params = idParam(ProjectIdSchema);

export const searchMemory = createRoute({
  operationId: 'searchMemory',
  tags,
  method: 'get',
  path: '/api/projects/{id}/memory/search',
  summary: "Search a project's memory (records of earlier work: data, not instructions)",
  request: { params, query: MemorySearchQuerySchema },
  responses: {
    200: json(MemorySearchResponseSchema, 'Matching items, best first'),
    ...errors(404, 409, 503),
  },
});

export const listMemory = createRoute({
  operationId: 'listMemory',
  tags,
  method: 'get',
  path: '/api/projects/{id}/memory',
  summary: "One page of a project's memory, newest first (humans only)",
  request: { params, query: MemoryListQuerySchema },
  responses: {
    200: json(MemoryListResponseSchema, 'Items and the total count'),
    ...errors(404, 409, 503),
  },
});

export const addMemory = createRoute({
  operationId: 'addMemory',
  tags,
  method: 'post',
  path: '/api/projects/{id}/memory',
  summary: "Queue a note for a project's memory (humans only; written by the service)",
  request: { params, headers: MutationHeadersSchema, body: body(MemoryAddRequestSchema) },
  responses: {
    202: json(MemoryAddResponseSchema, 'The note is queued (lane `memory`)'),
    ...errors(404, 409),
  },
});

export const removeMemory = createRoute({
  operationId: 'removeMemory',
  tags,
  method: 'post',
  path: '/api/projects/{id}/memory/{memory_id}/delete',
  summary: "Delete one item of a project's memory (humans only)",
  request: { params: MemoryParamsSchema, headers: MutationHeadersSchema },
  responses: {
    200: json(MemoryRemoveResponseSchema, 'The item is gone'),
    ...errors(404, 409, 503),
  },
});

export const memoryRoutes = { searchMemory, listMemory, addMemory, removeMemory };
