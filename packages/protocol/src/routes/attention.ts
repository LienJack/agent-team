import { createRoute } from '@hono/zod-openapi';
import {
  AttentionAnswerRequestSchema,
  AttentionCreateRequestSchema,
  AttentionIdSchema,
  AttentionListQuerySchema,
  AttentionListResponseSchema,
  AttentionResponseSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema } from '../common.js';

const tags = ['attention'];

export const listAttention = createRoute({
  operationId: 'listAttention',
  tags,
  method: 'get',
  path: '/api/attention',
  summary: 'Attention items (decisions, approvals, questions), optionally by status',
  request: { query: AttentionListQuerySchema },
  responses: { 200: json(AttentionListResponseSchema, 'Attention items'), ...errors() },
});

export const createAttention = createRoute({
  operationId: 'createAttention',
  tags,
  method: 'post',
  path: '/api/attention',
  summary: 'Open an attention item (`team attention open`)',
  request: { headers: MutationHeadersSchema, body: body(AttentionCreateRequestSchema) },
  responses: { 201: json(AttentionResponseSchema, 'The opened item'), ...errors(404) },
});

export const answerAttention = createRoute({
  operationId: 'answerAttention',
  tags,
  method: 'post',
  path: '/api/attention/{id}/answer',
  summary: 'Answer an open attention item',
  request: {
    params: idParam(AttentionIdSchema),
    headers: MutationHeadersSchema,
    body: body(AttentionAnswerRequestSchema),
  },
  responses: { 200: json(AttentionResponseSchema, 'The answered item'), ...errors(404, 409) },
});

export const attentionRoutes = { listAttention, createAttention, answerAttention };
