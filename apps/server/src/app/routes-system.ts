import { NotFoundError, ValidationError } from '@agent-team/core';
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi';
import {
  getDoctor,
  getQuota,
  getResume,
  getRunLog,
  getState,
  listLeaderMessages,
  postLeaderMessage,
  streamEvents,
} from '@agent-team/protocol';
import type { StateResponse } from '@agent-team/schema';
import { ok, register } from './register.js';
import { readRunLog } from './run-log.js';
import { eventStream } from './sse.js';
import type { AppContext, AppEnv } from './types.js';

/** GET /api/state: one synchronous read, so `last_seq` matches the rows exactly. */
export function boardSnapshot(ctx: AppContext): StateResponse {
  const { store } = ctx;
  return {
    last_seq: store.events.lastSeq(),
    generated_at: ctx.clock.now().toISOString(),
    projects: store.projects.list(),
    tasks: store.tasks.list(),
    active_runs: store.runs.list({ states: ['starting', 'running'] }),
    open_attention: store.attention.list({ statuses: ['open'] }),
    runners: ctx.engine.runnerStatuses(),
    leader: ctx.leader.status(),
  };
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
      source: body.source,
      body: body.text,
      client_msg_id: body.client_msg_id,
    });
    const reply = await ctx.leader.handleMessage(message, { duplicate });
    return ok({
      reply: reply.reply,
      message_id: message.id,
      reply_message_id: reply.reply_message_id,
    });
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

  register(app, getResume, () =>
    ok({ summary_md: ctx.leader.resumeBrief(), generated_at: ctx.clock.now().toISOString() }),
  );
  register(app, getQuota, () => ok({ runners: ctx.engine.runnerStatuses() }));
  register(app, getDoctor, async () => ok(await ctx.doctor()));
}
