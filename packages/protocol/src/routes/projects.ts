import { createRoute } from '@hono/zod-openapi';
import {
  ProjectCreateRequestSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
} from '@agent-team/schema';
import { body, errors, json, MutationHeadersSchema } from '../common.js';

const tags = ['projects'];

export const listProjects = createRoute({
  operationId: 'listProjects',
  tags,
  method: 'get',
  path: '/api/projects',
  summary: 'All projects',
  responses: { 200: json(ProjectListResponseSchema, 'Projects ordered by creation'), ...errors() },
});

/** Register a repository on this machine (humans only; both listeners, docs/adr/0024). */
export const createProject = createRoute({
  operationId: 'createProject',
  tags,
  method: 'post',
  path: '/api/projects',
  summary: 'Register a project',
  request: { headers: MutationHeadersSchema, body: body(ProjectCreateRequestSchema) },
  responses: { 201: json(ProjectResponseSchema, 'The created project'), ...errors(409) },
});

export const projectRoutes = { listProjects, createProject };
