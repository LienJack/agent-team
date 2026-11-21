import { NotFoundError, ValidationError } from '@agent-team/core';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  answerAttention,
  approveTask,
  cancelTask,
  createAttention,
  createProject,
  createTask,
  getTask,
  listAttention,
  listProjects,
  listTasks,
  queueTask,
  reassignTask,
  rejectTask,
  retryTask,
} from '@agent-team/protocol';
import { created, ok, register } from './register.js';
import type { AppContext, AppEnv } from './types.js';

// Projects, tasks and attention (spec §11). Handlers only translate HTTP to engine commands
// (state changes) or store reads; every state change goes through the engine.

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
    return created({ project: engine.createProject(body) });
  });

  register(app, listTasks, (c) => {
    const query = c.req.valid('query');
    const tasks = store.tasks.list({
      ...(query.project_id === undefined ? {} : { project_id: query.project_id }),
      ...(query.status === undefined ? {} : { statuses: query.status }),
    });
    return ok({ tasks });
  });

  register(app, createTask, (c) =>
    created({ task: engine.createTask(c.req.valid('json'), c.get('actor')) }),
  );

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

  register(app, queueTask, (c) =>
    ok({ task: engine.queueTask(c.req.valid('param').id, c.get('actor')) }),
  );
  register(app, cancelTask, (c) => {
    const { reason } = c.req.valid('json');
    return ok({ task: engine.cancelTask(c.req.valid('param').id, reason) });
  });
  register(app, retryTask, (c) =>
    ok({ task: engine.retryTask(c.req.valid('param').id, c.get('actor')) }),
  );
  register(app, approveTask, (c) => {
    const { reason } = c.req.valid('json');
    return ok({ task: engine.approveTask(c.req.valid('param').id, reason) });
  });
  register(app, rejectTask, (c) => {
    const { note } = c.req.valid('json');
    return ok({ task: engine.rejectTask(c.req.valid('param').id, note, c.get('actor')) });
  });
  register(app, reassignTask, (c) => {
    const { role } = c.req.valid('json');
    return ok({ task: engine.reassignTask(c.req.valid('param').id, role, c.get('actor')) });
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
    const { answer, via } = c.req.valid('json');
    // the leader's own answers are recorded as such (they never re-enter its event digest)
    const by = c.get('actor').kind === 'leader' ? 'leader' : via;
    return ok({ attention: engine.answerAttention(c.req.valid('param').id, answer, by) });
  });
}
