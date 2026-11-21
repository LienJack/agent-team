import type { OpenAPIHono, RouteConfig, RouteHandler } from '@hono/zod-openapi';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { AppEnv } from './types.js';

/** Typed request context of a route (validated params/query/json via `c.req.valid`). */
export type RouteContext<R extends RouteConfig> = Parameters<RouteHandler<R, AppEnv>>[0];

export interface Reply {
  status: number;
  body: unknown;
}

export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });

function responseSchema(route: RouteConfig, status: number): ZodType | undefined {
  const response = route.responses[String(status)] as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined;
  const schema = response?.content?.['application/json']?.schema;
  return schema !== undefined && typeof (schema as ZodType).safeParse === 'function'
    ? (schema as ZodType)
    : undefined;
}

/**
 * Register a JSON route. Requests are validated by zod-openapi (failures → 400 envelope); the
 * reply is validated against the route's response schema, so a handler can never send a shape
 * the generated client does not expect (a mismatch is a bug → 500).
 */
export function register<R extends RouteConfig>(
  app: OpenAPIHono<AppEnv>,
  route: R,
  handler: (c: RouteContext<R>) => Reply | Promise<Reply>,
): void {
  const wrapped = async (c: RouteContext<R>) => {
    const reply = await handler(c);
    const schema = responseSchema(route, reply.status);
    if (!schema) throw new Error(`${route.operationId}: no response schema for ${reply.status}`);
    const checked = schema.safeParse(reply.body);
    if (!checked.success) {
      throw new Error(
        `${route.operationId}: response does not match its schema: ${checked.error.issues[0]?.message}`,
      );
    }
    return c.json(reply.body as never, reply.status as ContentfulStatusCode);
  };
  app.openapi(route, wrapped as unknown as RouteHandler<R, AppEnv>);
}
