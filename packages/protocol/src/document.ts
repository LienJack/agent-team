import { OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import {
  AttentionSchema,
  ErrorEnvelopeSchema,
  MessageSchema,
  ProjectSchema,
  RunnerCapabilitiesSchema,
  RunnerStatusSchema,
  RunSchema,
  TaskSchema,
  WorkspaceSchema,
} from '@agent-team/schema';
import type { z } from 'zod';
import { ERROR_RESPONSE, LOCAL_ONLY_EXTENSION, SESSION_COOKIE_NAME } from './constants.js';
import { attentionRoutes } from './routes/attention.js';
import { authRoutes } from './routes/auth.js';
import { leaderRoutes } from './routes/leader.js';
import { projectRoutes } from './routes/projects.js';
import { systemRoutes } from './routes/system.js';
import { taskRoutes } from './routes/tasks.js';

/** Every route contract, keyed by operationId. */
export const routes = {
  ...systemRoutes,
  ...projectRoutes,
  ...taskRoutes,
  ...leaderRoutes,
  ...attentionRoutes,
  ...authRoutes,
};
export type RouteName = keyof typeof routes;
export const ALL_ROUTES: readonly RouteConfig[] = Object.values(routes);

/** True for routes the LAN listener must refuse (spec §11: project writes, settings writes). */
export function isLocalOnly(route: RouteConfig): boolean {
  return (route as Record<string, unknown>)[LOCAL_ONLY_EXTENSION] === true;
}

/** Domain objects emitted once under components/schemas and referenced everywhere else. */
const COMPONENTS: ReadonlyArray<[string, z.ZodType]> = [
  ['Project', ProjectSchema],
  ['Task', TaskSchema],
  ['Workspace', WorkspaceSchema],
  ['Run', RunSchema],
  ['Attention', AttentionSchema],
  ['Message', MessageSchema],
  ['RunnerStatus', RunnerStatusSchema],
  ['RunnerCapabilities', RunnerCapabilitiesSchema],
  ['ErrorEnvelope', ErrorEnvelopeSchema],
];

const COMPONENT_PATH = '/__component/';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Replace every inline copy of a component schema with a `$ref`. zod-to-openapi only refs the
 * instances it registered itself, and the schema package composes its DTOs from the plain
 * instances, so without this every response would inline whole domain objects.
 */
function dedupe(node: Json, byJson: Map<string, string>, isRoot = false): Json {
  if (Array.isArray(node)) return node.map((item) => dedupe(item, byJson));
  if (node === null || typeof node !== 'object') return node;
  if (!isRoot) {
    const name = byJson.get(JSON.stringify(node));
    if (name !== undefined) return { $ref: `#/components/schemas/${name}` };
    // `X.nullable()` is emitted as X with `type: [t, 'null']`
    const type = node['type'];
    if (Array.isArray(type) && type.length === 2 && type.includes('null')) {
      const nonNull = type.find((t) => t !== 'null') ?? null;
      const nullable = byJson.get(JSON.stringify({ ...node, type: nonNull }));
      if (nullable !== undefined) {
        return { anyOf: [{ $ref: `#/components/schemas/${nullable}` }, { type: 'null' }] };
      }
    }
  }
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) out[key] = dedupe(value, byJson);
  return out;
}

/** The OpenAPI 3.1 document of the API (committed as `packages/protocol/openapi.json`). */
export function buildOpenApiDocument(): Record<string, unknown> {
  const app = new OpenAPIHono();
  const registry = app.openAPIRegistry;
  // `registry.register()` needs zod's `.openapi()` extension on the schema package's zod
  // instance, which is not guaranteed (vitest may load a second copy). Render each component
  // through a temporary path instead and move the result under components/schemas.
  for (const [name, schema] of COMPONENTS) {
    registry.registerPath({
      method: 'get',
      path: `${COMPONENT_PATH}${name}`,
      responses: { 200: { description: name, content: { 'application/json': { schema } } } },
    });
  }
  registry.registerComponent('responses', ERROR_RESPONSE, {
    description: 'Error envelope `{ error: { code, message, hint? } }`',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
    },
  });
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Local listener: the token from DATA/run/listener.json (new on every start)',
  });
  registry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE_NAME,
    description: 'LAN listener: session cookie from POST /auth/login',
  });
  for (const route of ALL_ROUTES) registry.registerPath(route);

  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'agent-team',
      version: '1.0.0',
      description:
        'Local multi-agent development service (docs/spec.md §11). Generated from ' +
        '@agent-team/protocol; do not edit by hand.',
    },
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
  }) as unknown as { [key: string]: Json };

  const paths = doc['paths'] as { [path: string]: Json };
  const components = doc['components'] as { [key: string]: Json };
  const schemas: { [key: string]: Json } = {};
  for (const [name] of COMPONENTS) {
    const helper = paths[`${COMPONENT_PATH}${name}`] as {
      get: { responses: { 200: { content: { 'application/json': { schema: Json } } } } };
    };
    schemas[name] = helper.get.responses[200].content['application/json'].schema;
    delete paths[`${COMPONENT_PATH}${name}`];
  }
  const byJson = new Map<string, string>();
  for (const [name] of COMPONENTS) byJson.set(JSON.stringify(schemas[name]), name);
  for (const [name] of COMPONENTS) schemas[name] = dedupe(schemas[name]!, byJson, true);
  doc['paths'] = dedupe(paths, byJson);
  const rest = Object.entries(components).filter(
    ([key, value]) => key !== 'schemas' && Object.keys(value ?? {}).length > 0,
  );
  doc['components'] = { schemas, ...Object.fromEntries(rest) };
  return doc;
}
