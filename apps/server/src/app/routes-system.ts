import { NotFoundError, ValidationError } from '@agent-team/core';
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi';
import {
  getDoctor,
  getLeaderMessage,
  getQuota,
  getResume,
  getRoles,
  getRunLog,
  getState,
  listLeaderMessages,
  postLeaderMessage,
  resetLeader,
  streamEvents,
} from '@agent-team/protocol';
import type { LeaderMessageResponse, Message, ModelsConfig, RoleInfo } from '@agent-team/schema';
import { findReply } from '../leader/persist.js';
import type { LeaderReply } from '../leader/types.js';
import { boardSnapshot } from './board.js';
import { messageSource } from './origin.js';
import { ok, register } from './register.js';
import { readRunLog } from './run-log.js';
import { eventStream } from './sse.js';
import type { AppContext, AppEnv } from './types.js';

/** GET /api/roles: the roles of config/models.json in file order. */
export function roleList(models: ModelsConfig): RoleInfo[] {
  return Object.entries(models.roles).map(([name, role]) => ({
    name,
    description: role.desc ?? null,
    model_alias: role.use,
    // the schema cross-checks every `use` against `models`
    runner: models.models[role.use]!.runner,
    slots: role.slots,
    enabled: role.enabled,
    fallback: role.fallback,
  }));
}

/** Resolves with `promise`, or undefined once `ms` passed (the promise keeps running). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

function cursorFrom(query: number | null | undefined, lastEventId: string | undefined) {
  if (query !== undefined && query !== null) return query;
  if (lastEventId === undefined) return undefined;
  if (!/^\d+$/.test(lastEventId)) throw new ValidationError('Last-Event-ID must be a seq number');
  return Number(lastEventId);
}

export function registerSystemRoutes(app: OpenAPIHono<AppEnv>, ctx: AppContext): void {
  const { store } = ctx;

  register(app, getState, () => ok(boardSnapshot(ctx)));

  const events: RouteHandler<typeof streamEvents, AppEnv> = (c) => {
    const { after } = c.req.valid('query');
    const body = eventStream({
      store,
      hub: ctx.events,
      now: () => ctx.clock.now(),
      after: cursorFrom(after, c.req.header('last-event-id')),
      heartbeatMs: ctx.service.sse.heartbeat_ms,
      maxQueue: ctx.service.sse.max_queue,
    });
    return c.body(body, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }) as never;
  };
  app.openapi(streamEvents, events);

  register(app, getRunLog, async (c) => {
    const { id } = c.req.valid('param');
    const { tail } = c.req.valid('query');
    const run = store.runs.get(id);
    if (!run) throw new NotFoundError('run', id);
    return ok(await readRunLog(run, ctx.dataDir, tail));
  });

  register(app, postLeaderMessage, async (c) => {
    const body = c.req.valid('json');
    // stored first (deduplicated per channel by client_msg_id), then handed to the leader
    const { message, duplicate } = ctx.engine.recordMessage({
      channel: 'leader',
      direction: 'in',
      source: messageSource(c),
      body: body.text,
      client_msg_id: body.client_msg_id,
    });
    const answer = (reply: LeaderReply | undefined): LeaderMessageResponse => ({
      message_id: message.id,
      pending: reply === undefined,
      reply: reply?.reply ?? null,
      reply_message_id: reply?.reply_message_id ?? null,
      leader: ctx.leader.status(),
    });
    if (body.wait === false) return ok(answer(ctx.leader.submit(message, { duplicate })));
    // waiting is capped below the client's header timeout; then the caller polls
    const reply = await within(
      ctx.leader.handleMessage(message, { duplicate }),
      ctx.service.leader.reply_wait_ms,
    );
    return ok(answer(reply));
  });

  register(app, getLeaderMessage, (c) => {
    const { id } = c.req.valid('param');
    const message: Message | undefined = store.messages.get(id);
    if (!message || message.channel !== 'leader' || message.direction !== 'in') {
      throw new NotFoundError('leader message', id);
    }
    return ok({ message, reply: findReply(store, message) ?? null, leader: ctx.leader.status() });
  });

  register(app, listLeaderMessages, (c) => {
    const { after, limit } = c.req.valid('query');
    const messages = store.messages.list({
      channel: 'leader',
      limit,
      ...(after === undefined || after === null ? {} : { afterSeq: after }),
    });
    return ok({ messages });
  });

  register(app, resetLeader, async () => {
    const { session_id } = await ctx.leader.resetSession();
    return ok({ session_id, leader: ctx.leader.status() });
  });

  register(app, getResume, () =>
    ok({ summary_md: ctx.leader.resumeBrief(), generated_at: ctx.clock.now().toISOString() }),
  );
  register(app, getRoles, () => ok({ roles: roleList(ctx.engine.ctx.config.models) }));
  register(app, getQuota, () => ok({ runners: ctx.engine.runnerStatuses() }));
  register(app, getDoctor, async () => ok(await ctx.doctor()));
}
