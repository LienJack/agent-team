import type { OpenAPIHono } from '@hono/zod-openapi';
import { addMemory, listMemory, removeMemory, searchMemory } from '@agent-team/protocol';
import { ok, register } from './register.js';
import type { AppContext, AppEnv } from './types.js';

// Project memory (spec §18). Thin: the engine checks that memory is on (409), the actor (the
// leader may only search) and the project, and turns MemOS failures into 503.

export function registerMemoryRoutes(app: OpenAPIHono<AppEnv>, ctx: AppContext): void {
  const { engine } = ctx;

  register(app, searchMemory, async (c) => {
    const { id } = c.req.valid('param');
    const { q, limit } = c.req.valid('query');
    return ok({ project_id: id, memories: await engine.searchMemory(id, q, limit) });
  });

  register(app, listMemory, async (c) => {
    const { id } = c.req.valid('param');
    const { page, page_size } = c.req.valid('query');
    const result = await engine.listMemory(id, { page, pageSize: page_size }, c.get('actor'));
    return ok({ project_id: id, memories: result.items, total: result.total, page, page_size });
  });

  register(app, addMemory, (c) => {
    const { id } = c.req.valid('param');
    const sourceId = engine.addMemory(id, c.req.valid('json').text, c.get('actor'));
    return { status: 202, body: { project_id: id, source_id: sourceId, queued: true } };
  });

  register(app, removeMemory, async (c) => {
    const { id, memory_id } = c.req.valid('param');
    await engine.removeMemory(id, memory_id, c.get('actor'));
    return ok({ project_id: id, memory_id, removed: true });
  });
}
