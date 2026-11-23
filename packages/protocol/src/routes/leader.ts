import { createRoute } from '@hono/zod-openapi';
import {
  LeaderMessageDetailResponseSchema,
  LeaderMessageRequestSchema,
  LeaderResetResponseSchema,
  LeaderMessageResponseSchema,
  LeaderMessagesQuerySchema,
  LeaderMessagesResponseSchema,
  MessageIdSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema } from '../common.js';

const tags = ['leader'];

/**
 * Send a message to the leader conversation. The message is stored first (deduplicated by
 * `client_msg_id`), then queued for the leader. `wait: false` answers at once with
 * `pending: true` (the reply follows as a `leader.reply` event and in GET /leader/messages).
 * `wait: true` (default) waits for the reply up to `leader.reply_wait_ms` (240 s), then answers
 * `pending: true` (poll GET /leader/messages/{id}); while waiting is impossible (rate limit,
 * login, no CLI) it answers 503 `unavailable` and the message stays queued. A duplicate
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

/** One input message and its reply (callers waiting on a `pending` message poll this). */
export const getLeaderMessage = createRoute({
  operationId: 'getLeaderMessage',
  tags,
  method: 'get',
  path: '/api/leader/messages/{id}',
  summary: 'One leader message and its reply (null while pending)',
  request: { params: idParam(MessageIdSchema) },
  responses: {
    200: json(LeaderMessageDetailResponseSchema, 'The message, its reply, the leader status'),
    ...errors(404),
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
 * e.g. after logging in with another account. Humans only (both listeners, docs/adr/0024).
 */
export const resetLeader = createRoute({
  operationId: 'resetLeader',
  tags,
  method: 'post',
  path: '/api/leader/reset',
  summary: 'New leader conversation',
  request: { headers: MutationHeadersSchema },
  responses: { 200: json(LeaderResetResponseSchema, 'The new session'), ...errors(503) },
});

export const leaderRoutes = {
  postLeaderMessage,
  listLeaderMessages,
  getLeaderMessage,
  resetLeader,
};
