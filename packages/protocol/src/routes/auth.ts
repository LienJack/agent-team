import { createRoute } from '@hono/zod-openapi';
import { LoginRequestSchema, LoginResponseSchema } from '@agent-team/schema';
import { z } from 'zod';
import { body, errors } from '../common.js';
import { SESSION_COOKIE_NAME } from '../constants.js';

/**
 * LAN listener only (spec §11): exchange the password for an HMAC-signed session cookie
 * (HttpOnly, SameSite=Strict). Five consecutive failures from one source lock it for 15 minutes
 * (429 `locked`). The local listener answers 404: it uses the bearer token instead.
 */
export const login = createRoute({
  operationId: 'login',
  tags: ['auth'],
  method: 'post',
  path: '/auth/login',
  summary: 'Log in to the LAN board',
  security: [],
  request: { body: body(LoginRequestSchema) },
  responses: {
    200: {
      description: 'Logged in',
      headers: z.object({
        'Set-Cookie': z
          .string()
          .describe(`${SESSION_COOKIE_NAME}=…; HttpOnly; SameSite=Strict; Path=/`),
      }),
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    ...errors(429),
  },
});

export const authRoutes = { login };
