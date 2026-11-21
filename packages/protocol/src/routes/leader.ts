import { createRoute } from '@hono/zod-openapi';
import {
  LeaderMessageRequestSchema,
  LeaderMessageResponseSchema,
  LeaderMessagesQuerySchema,
  LeaderMessagesResponseSchema,
} from '@agent-team/schema';
import { body, errors, json, MutationHeadersSchema } from '../common.js';

const tags = ['leader'];

/**
 * Send a message to the leader conversation. The message is stored first (deduplicated by
 * `client_msg_id`), then handed to the leader; 503 `unavailable` while no leader is running,
 * 501 `not_implemented` while the leader is still the phase 2 stub.
 */
export const postLeaderMessage = createRoute({
  operationId: 'postLeaderMessage',
  tags,
  method: 'post',
  path: '/api/leader/messages',
  summary: 'Talk to the leader',
  request: { headers: MutationHeadersSchema, body: body(LeaderMessageRequestSchema) },
  responses: {
    200: json(LeaderMessageResponseSchema, 'The leader’s reply'),
    ...errors(409, 501, 503),
  },
});

export const listLeaderMessages = createRoute({
  operationId: 'listLeaderMessages',
  tags,
  method: 'get',
  path: '/api/leader/messages',
  summary: 'Leader conversation messages after a seq cursor',
  request: { query: LeaderMessagesQuerySchema },
  responses: { 200: json(LeaderMessagesResponseSchema, 'Messages ordered by seq'), ...errors() },
});

export const leaderRoutes = { postLeaderMessage, listLeaderMessages };
