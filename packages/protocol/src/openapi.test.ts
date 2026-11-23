import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { ALL_ROUTES, buildOpenApiDocument } from './document.js';
import { formatWithOxfmt, workspaceRoot } from './scripts/format.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const committedPath = fileURLToPath(new URL('../openapi.json', import.meta.url));

/** Spec §11 route list (every path under /api). Keep docs/spec.md §11 in sync. */
const SPEC_ROUTES = [
  'GET /api/state',
  'GET /api/events',
  'GET /api/projects',
  'POST /api/projects',
  'PATCH /api/projects/{id}',
  'GET /api/tasks',
  'POST /api/tasks',
  'GET /api/tasks/{id}',
  'POST /api/tasks/{id}/queue',
  'POST /api/tasks/{id}/cancel',
  'POST /api/tasks/{id}/retry',
  'POST /api/tasks/{id}/approve',
  'POST /api/tasks/{id}/reject',
  'POST /api/tasks/{id}/reassign',
  'POST /api/research',
  'GET /api/research/{id}',
  'GET /api/projects/{id}/memory/search',
  'GET /api/projects/{id}/memory',
  'POST /api/projects/{id}/memory',
  'POST /api/projects/{id}/memory/{memory_id}/delete',
  'GET /api/runs/{id}/log',
  'POST /api/leader/messages',
  'GET /api/leader/messages',
  'GET /api/leader/messages/{id}',
  'POST /api/leader/reset',
  'GET /api/attention',
  'POST /api/attention',
  'POST /api/attention/{id}/answer',
  'GET /api/resume',
  'GET /api/roles',
  'GET /api/quota',
  'GET /api/doctor',
];

describe('route contracts (spec §11)', () => {
  it('cover exactly the spec routes', () => {
    const actual = ALL_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
    expect(actual).toEqual([...SPEC_ROUTES].sort());
  });

  it('mark no route local-only and need no LAN credential (docs/adr/0024)', () => {
    const doc = buildOpenApiDocument() as {
      security: unknown;
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    const ops = Object.values(doc.paths).flatMap((byMethod) => Object.values(byMethod));
    expect(ops.some((op) => 'x-local-only' in op)).toBe(false);
    expect(Object.keys(doc.paths).every((p) => p.startsWith('/api/'))).toBe(true);
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['bearerAuth']);
    expect(doc.security).toEqual([{ bearerAuth: [] }, {}]);
  });

  it('accept an Idempotency-Key on every mutating /api route', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>>;
    };
    for (const route of ALL_ROUTES) {
      if (route.method !== 'post' || !route.path.startsWith('/api/')) continue;
      const op = doc.paths[route.path]?.[route.method];
      const names = (op?.parameters ?? []).filter((p) => p.in === 'header').map((p) => p.name);
      expect({ route: route.operationId, names }).toEqual({
        route: route.operationId,
        names: expect.arrayContaining([IDEMPOTENCY_HEADER]),
      });
    }
  });

  it('references shared domain components instead of inlining them', () => {
    const doc = buildOpenApiDocument() as {
      paths?: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(Object.keys(doc.components.schemas)).toContain('Task');
    expect(Object.keys(doc.paths ?? {}).some((p) => p.startsWith('/__'))).toBe(false);
    const text = JSON.stringify(doc);
    expect(text).toContain('"#/components/schemas/Task"');
    expect(text).toContain('"#/components/responses/Error"');
  });
});

describe('openapi.json drift', () => {
  it('the committed file equals the generated, formatted document', () => {
    const committed = readFileSync(committedPath, 'utf8');
    expect(JSON.parse(committed)).toEqual(buildOpenApiDocument());
    const formatted = formatWithOxfmt(
      workspaceRoot(packageDir),
      'openapi.json',
      `${JSON.stringify(buildOpenApiDocument())}\n`,
    );
    // on failure: run `pnpm --filter @agent-team/protocol generate`
    expect(committed).toBe(formatted);
  });
});
