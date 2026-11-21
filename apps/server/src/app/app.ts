import { TeamError } from '@agent-team/core';
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  ALL_ROUTES,
  answerAttention,
  approveTask,
  createProject,
  getLeaderMessage,
  getRunLog,
  isLocalOnly,
  listLeaderMessages,
  login,
  postLeaderMessage,
  reassignTask,
  rejectTask,
  resetLeader,
  streamEvents,
} from '@agent-team/protocol';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth, type LanAuth } from '../auth/guards.js';
import { notFound, onError, validationHook } from './errors.js';
import { idempotency } from './idempotency.js';
import { registerSystemRoutes } from './routes-system.js';
import { registerWorkRoutes } from './routes-work.js';
import { registerStatic } from './static.js';
import type { AppContext, AppEnv } from './types.js';

export type AppOptions =
  | { listener: 'local'; token: string; leaderToken: string }
  | { listener: 'lan'; lan: LanAuth };

const MAX_BODY_BYTES = 1024 * 1024;

/** Routes the LAN listener refuses (spec §11: project writes; settings writes would join). */
function lanForbidden(): MiddlewareHandler<AppEnv> {
  const blocked = ALL_ROUTES.filter(isLocalOnly).map((route) => ({
    method: route.method.toUpperCase(),
    path: routePattern(route.path),
  }));
  return async (c, next) => {
    if (blocked.some((b) => b.method === c.req.method && b.path.test(c.req.path))) {
      throw new TeamError(
        'lan_forbidden',
        `${c.req.method} ${c.req.path} is only available on the local listener`,
        'run it on this machine, e.g. `team project add`',
      );
    }
    await next();
  };
}

const routePattern = (path: string) => new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`);

/**
 * Routes the leader actor may not call (spec §1 principle 1, §9; docs/adr/0014): run logs and
 * conversation transcripts are for humans only; `team ask` (its own queue) and `team watch`
 * (never ends) would hang its turn; decisions that bypass review or change what runs where —
 * approve, reject, reassign, answering attention items — resetting its own conversation and
 * registering local repositories are the owner's calls. The engine refuses the human-only
 * commands to the leader as well; this list answers early with a clear hint.
 */
export const LEADER_FORBIDDEN = [
  createProject,
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
];

function leaderForbidden(): MiddlewareHandler<AppEnv> {
  const blocked = LEADER_FORBIDDEN.map((route) => ({
    method: route.method.toUpperCase(),
    path: routePattern(route.path),
  }));
  return async (c, next) => {
    if (
      c.get('actor').kind === 'leader' &&
      blocked.some((b) => b.method === c.req.method && b.path.test(c.req.path))
    ) {
      throw new TeamError(
        'forbidden',
        `${c.req.method} ${c.req.path} is not available to the leader`,
        'the leader works from receipts and `team task show`; approvals, answers, reassignment, run logs, transcripts and project registration are for humans (open an attention item)',
      );
    }
    await next();
  };
}

/**
 * The Hono app of one listener (spec §11). Both listeners serve the same routes against the same
 * engine; they differ in authentication (bearer token vs. password session cookie), origin
 * checks, LAN-forbidden routes and the board's static files (LAN only).
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
  app.use('/auth/*', bodyLimit({ maxSize: 16 * 1024 }));

  if (options.listener === 'local') {
    app.use('/api/*', bearerAuth({ operator: options.token, leader: options.leaderToken }));
    app.use('/api/*', leaderForbidden());
  } else {
    app.use('/api/*', options.lan.originGuard);
    app.use('/auth/*', options.lan.originGuard);
    app.use('/api/*', options.lan.sessionGuard);
    app.use('/api/*', lanForbidden());
  }
  app.use('/api/*', idempotency(ctx));

  registerWorkRoutes(app, ctx);
  registerSystemRoutes(app, ctx);

  if (options.listener === 'lan') {
    const lan = options.lan;
    const handler: RouteHandler<typeof login, AppEnv> = (c) =>
      lan.login(c, c.req.valid('json').password) as never;
    app.openapi(login, handler);
    registerStatic(app, ctx.webDist);
  }
  return app;
}
