import { NotFoundError, researchReceiptOf, ValidationError } from '@agent-team/core';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  answerAttention,
  approveTask,
  cancelTask,
  createAttention,
  createProject,
  createResearch,
  createTask,
  getResearch,
  getTask,
  listAttention,
  listProjects,
  listTasks,
  queueTask,
  reassignTask,
  rejectTask,
  retryTask,
} from '@agent-team/protocol';
import { settledReply } from './delivery.js';
import { answerVia } from './origin.js';
import { created, ok, register } from './register.js';
import type { AppContext, AppEnv } from './types.js';

// Projects, tasks and attention (spec §11). Handlers only translate HTTP to engine commands
// (state changes) or store reads; every state change goes through the engine. Task commands
// answer with the task's delivery and report after one scheduling pass (docs/adr/0022).

export function registerWorkRoutes(app: OpenAPIHono<AppEnv>, ctx: AppContext): void {
  const { engine, store } = ctx;

  register(app, listProjects, () => ok({ projects: store.projects.list() }));

  register(app, createProject, async (c) => {
    const body = c.req.valid('json');
    if (ctx.checkRepo) {
      try {
        await ctx.checkRepo(body.repo_path, body.base_branch);
      } catch (err) {
        throw new ValidationError(
          `repo_path: ${body.repo_path} has no branch ${body.base_branch} (${(err as Error).message})`,
          'point repo_path at the primary checkout of a git repository',
        );
      }
    }
    return created({ project: engine.createProject(body, c.get('actor')) });
  });

  register(app, listTasks, (c) => {
    const query = c.req.valid('query');
    const tasks = store.tasks.list({
      ...(query.project_id === undefined ? {} : { project_id: query.project_id }),
      ...(query.status === undefined ? {} : { statuses: query.status }),
    });
    return ok({ tasks });
  });

  register(app, createTask, async (c) => {
    const task = engine.createTask(c.req.valid('json'), c.get('actor'));
    return created(await settledReply(ctx, task.id));
  });

  register(app, getTask, (c) => {
    const { id } = c.req.valid('param');
    const task = store.tasks.get(id);
    if (!task) throw new NotFoundError('task', id);
    return ok({
      task,
      runs: store.runs.list({ task_id: id }),
      workspace: store.workspaces.findCurrentByTask(id) ?? null,
      attention: store.attention.list({ task_id: id }),
    });
  });

  // research stage (spec §17): the engine answers 409 while research.mode is off
  register(app, createResearch, async (c) => {
    const task = engine.createResearch(c.req.valid('json'), c.get('actor'));
    return created(await settledReply(ctx, task.id));
  });
  register(app, getResearch, (c) => {
    const { id } = c.req.valid('param');
    const task = store.tasks.get(id);
    if (!task || task.kind !== 'research') throw new NotFoundError('research task', id);
    const found = researchReceiptOf(store, id, { any: true });
    return ok({ task, receipt: found?.receipt ?? null, run_id: found?.run.id ?? null });
  });

  const reply = async (task: { id: string }) => ok(await settledReply(ctx, task.id));
  register(app, queueTask, (c) => reply(engine.queueTask(c.req.valid('param').id, c.get('actor'))));
  register(app, cancelTask, (c) => {
    const { reason } = c.req.valid('json');
    return reply(engine.cancelTask(c.req.valid('param').id, reason));
  });
  register(app, retryTask, (c) => reply(engine.retryTask(c.req.valid('param').id, c.get('actor'))));
  register(app, approveTask, (c) => {
    const { reason } = c.req.valid('json');
    return reply(engine.approveTask(c.req.valid('param').id, reason, c.get('actor')));
  });
  register(app, rejectTask, (c) => {
    const { note } = c.req.valid('json');
    return reply(engine.rejectTask(c.req.valid('param').id, note, c.get('actor')));
  });
  register(app, reassignTask, (c) => {
    const { role } = c.req.valid('json');
    return reply(engine.reassignTask(c.req.valid('param').id, role, c.get('actor')));
  });

  register(app, listAttention, (c) => {
    const { status } = c.req.valid('query');
    return ok({
      attention: store.attention.list(status === undefined ? {} : { statuses: [status] }),
    });
  });
  register(app, createAttention, (c) =>
    created({ attention: engine.openAttention(c.req.valid('json')) }),
  );
  register(app, answerAttention, (c) => {
    const { answer } = c.req.valid('json');
    // humans only (the engine refuses the leader); the channel comes from the credential
    const id = c.req.valid('param').id;
    return ok({ attention: engine.answerAttention(id, answer, answerVia(c), c.get('actor')) });
  });
}
