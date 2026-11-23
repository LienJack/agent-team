// API contract (spec §11): route definitions without handlers, shared constants and the
// OpenAPI document builder. The server implements these routes; the client is generated from
// the committed `openapi.json`.
export * from './constants.js';
export { errors, MutationHeadersSchema } from './common.js';
export { ALL_ROUTES, buildOpenApiDocument, routes, type RouteName } from './document.js';
export * from './routes/attention.js';
export * from './routes/gate.js';
export * from './routes/leader.js';
export * from './routes/memory.js';
export * from './routes/projects.js';
export * from './routes/research.js';
export * from './routes/system.js';
export * from './routes/tasks.js';
