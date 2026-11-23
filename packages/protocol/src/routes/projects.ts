import { createRoute } from '@hono/zod-openapi';
import {
  ProjectCreateRequestSchema,
  ProjectIdSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  ProjectUpdateRequestSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema } from '../common.js';

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

/** Replace a project's machine checks (humans only; the leader gets 403). */
export const updateProject = createRoute({
  operationId: 'updateProject',
  tags,
  method: 'patch',
  path: '/api/projects/{id}',
  summary: "Change a project's checks",
  request: {
    params: idParam(ProjectIdSchema),
    headers: MutationHeadersSchema,
    body: body(ProjectUpdateRequestSchema),
  },
  responses: { 200: json(ProjectResponseSchema, 'The updated project'), ...errors(404) },
});

export const projectRoutes = { listProjects, createProject, updateProject };
