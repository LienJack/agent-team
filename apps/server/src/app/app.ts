import { TeamError } from '@agent-team/core';
import { OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import {
  ALL_ROUTES,
  addMemory,
  answerAttention,
  approveTask,
  createProject,
  updateProject,
  getLeaderMessage,
  getRunLog,
  listLeaderMessages,
  listMemory,
  postLeaderMessage,
  reassignTask,
  rejectTask,
  removeMemory,
  resetLeader,
  streamEvents,
} from '@agent-team/protocol';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth, lanHumanActor } from '../auth/guards.js';
import { notFound, onError, validationHook } from './errors.js';
import { refreshReplay } from './delivery.js';
import { idempotency } from './idempotency.js';
import { registerMemoryRoutes } from './routes-memory.js';
import { registerSystemRoutes } from './routes-system.js';
import { registerWorkRoutes } from './routes-work.js';
import { registerStatic } from './static.js';
import type { AppContext, AppEnv } from './types.js';

export type AppOptions =
  | { listener: 'local'; token: string; leaderToken: string }
  | { listener: 'lan' };

const MAX_BODY_BYTES = 1024 * 1024;

const routePattern = (path: string) => new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`);

/** The method a request is routed with: Hono answers HEAD with the GET handler. */
const routedMethod = (method: string) =>
  method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();

/**
 * Whether a guard refuses `method path`: one of `routes` (HEAD counts as GET), or — on a path
 * one of them guards — any method no route registers for that path (PUT, OPTIONS, …).
 */
function refusedBy(routes: readonly RouteConfig[]): (method: string, path: string) => boolean {
  const pattern = (route: RouteConfig) => ({
    method: route.method.toUpperCase(),
    path: routePattern(route.path),
  });
  const guarded = routes.map(pattern);
  const known = ALL_ROUTES.map(pattern);
  return (rawMethod, path) => {
    if (!guarded.some((g) => g.path.test(path))) return false;
    const method = routedMethod(rawMethod);
    if (guarded.some((g) => g.method === method && g.path.test(path))) return true;
    return !known.some((k) => k.method === method && k.path.test(path));
  };
}

/**
 * Routes the leader actor may not call (spec §1 principle 1, §9; docs/adr/0014): run logs and
 * conversation transcripts are for humans only; `team ask` (its own queue) and `team watch`
 * (never ends) would hang its turn; decisions that bypass review or change what runs where —
 * approve, reject, reassign, answering attention items — resetting its own conversation and
 * registering local repositories or changing their checks are the owner's calls. Of the project memory (spec §18) it may
 * only search: listing, adding and deleting items are a person's. The engine refuses the
 * human-only commands to the leader as well; this list answers early with a clear hint.
 */
export const LEADER_FORBIDDEN = [
  createProject,
  updateProject,
  approveTask,
  rejectTask,
  reassignTask,
  answerAttention,
  getRunLog,
  listLeaderMessages,
  getLeaderMessage,
  postLeaderMessage,
  streamEvents,
  resetLeader,
  listMemory,
  addMemory,
  removeMemory,
];

function leaderForbidden(): MiddlewareHandler<AppEnv> {
  const refused = refusedBy(LEADER_FORBIDDEN);
  return async (c, next) => {
    if (c.get('actor').kind === 'leader' && refused(c.req.method, c.req.path)) {
      throw new TeamError(
        'forbidden',
        `${c.req.method} ${c.req.path} is not available to the leader`,
        'the leader works from receipts and `team task show`; approvals, answers, reassignment, run logs, transcripts and project registration or settings are for humans (open an attention item)',
      );
    }
    await next();
  };
}

/**
 * The Hono app of one listener (spec §11). Both listeners serve the same routes against the same
 * engine. The local one needs a bearer token (which decides human or leader); the LAN one has no
 * authentication and no origin or host check — every request there is the human (docs/adr/0024)
 * — and serves the board's static files.
 */
export function createApp(ctx: AppContext, options: AppOptions): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.onError(onError(ctx.logger));
  app.notFound(notFound);

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES }));

  if (options.listener === 'local') {
    app.use('/api/*', bearerAuth({ operator: options.token, leader: options.leaderToken }));
    app.use('/api/*', leaderForbidden());
  } else {
    // no login, no Origin or Host check (owner's decision, docs/adr/0024): always the human
    app.use('/api/*', lanHumanActor);
  }
  app.use('/api/*', idempotency({ ...ctx, refresh: (body) => refreshReplay(ctx, body) }));

  registerWorkRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerSystemRoutes(app, ctx);

  if (options.listener === 'lan') registerStatic(app, ctx.webDist);
  return app;
}
