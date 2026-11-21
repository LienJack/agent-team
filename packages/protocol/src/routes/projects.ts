import { createRoute } from '@hono/zod-openapi';
import {
  ProjectCreateRequestSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
} from '@agent-team/schema';
import { body, errors, json, MutationHeadersSchema } from '../common.js';
import { LOCAL_ONLY_EXTENSION } from '../constants.js';

const tags = ['projects'];

export const listProjects = createRoute({
  operationId: 'listProjects',
  tags,
  method: 'get',
  path: '/api/projects',
  summary: 'All projects',
  responses: { 200: json(ProjectListResponseSchema, 'Projects ordered by creation'), ...errors() },
});

/** Local listener only: a project points at a path on this machine (spec §11). */
export const createProject = createRoute({
  operationId: 'createProject',
  tags,
  method: 'post',
  path: '/api/projects',
  summary: 'Register a project (local listener only)',
  [LOCAL_ONLY_EXTENSION]: true,
  request: { headers: MutationHeadersSchema, body: body(ProjectCreateRequestSchema) },
  responses: { 201: json(ProjectResponseSchema, 'The created project'), ...errors(409) },
});

export const projectRoutes = { listProjects, createProject };
