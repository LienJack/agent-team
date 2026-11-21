import { createRoute } from '@hono/zod-openapi';
import {
  LeaderMessageRequestSchema,
  LeaderResetResponseSchema,
  LeaderMessageResponseSchema,
  LeaderMessagesQuerySchema,
  LeaderMessagesResponseSchema,
} from '@agent-team/schema';
import { body, errors, json, MutationHeadersSchema } from '../common.js';
import { LOCAL_ONLY_EXTENSION } from '../constants.js';

const tags = ['leader'];

/**
 * Send a message to the leader conversation. The message is stored first (deduplicated by
 * `client_msg_id`), then handed to the leader; 503 `unavailable` while the leader cannot answer
 * (rate limit, login, no CLI): the message stays queued and is answered later. A duplicate
 * `client_msg_id` returns the stored reply.
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

/**
 * Start a new leader conversation (new session id; the next turn begins with the resume brief),
 * e.g. after logging in with another account. Local listener only: it is an operator action on
 * this machine.
 */
export const resetLeader = createRoute({
  operationId: 'resetLeader',
  tags,
  method: 'post',
  path: '/api/leader/reset',
  summary: 'New leader conversation (local listener only)',
  [LOCAL_ONLY_EXTENSION]: true,
  request: { headers: MutationHeadersSchema },
  responses: { 200: json(LeaderResetResponseSchema, 'The new session'), ...errors(503) },
});

export const leaderRoutes = { postLeaderMessage, listLeaderMessages, resetLeader };
