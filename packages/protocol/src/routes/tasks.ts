import { createRoute } from '@hono/zod-openapi';
import {
  TaskActionRequestSchema,
  TaskCreateRequestSchema,
  TaskDetailResponseSchema,
  TaskIdSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskReassignRequestSchema,
  TaskRejectRequestSchema,
  TaskResponseSchema,
} from '@agent-team/schema';
import { body, errors, idParam, json, MutationHeadersSchema, optionalBody } from '../common.js';

const tags = ['tasks'];
const params = idParam(TaskIdSchema);

export const listTasks = createRoute({
  operationId: 'listTasks',
  tags,
  method: 'get',
  path: '/api/tasks',
  summary: 'Tasks, optionally filtered by project and comma-separated statuses',
  request: { query: TaskListQuerySchema },
  responses: { 200: json(TaskListResponseSchema, 'Tasks ordered by creation'), ...errors() },
});

export const createTask = createRoute({
  operationId: 'createTask',
  tags,
  method: 'post',
  path: '/api/tasks',
  summary: 'Create a task (draft, or queued with `queue: true`)',
  request: { headers: MutationHeadersSchema, body: body(TaskCreateRequestSchema) },
  responses: { 201: json(TaskResponseSchema, 'The created task'), ...errors(404, 409) },
});

export const getTask = createRoute({
  operationId: 'getTask',
  tags,
  method: 'get',
  path: '/api/tasks/{id}',
  summary: 'A task with its runs (receipts included), workspace and attention items',
  request: { params },
  responses: { 200: json(TaskDetailResponseSchema, 'Task detail'), ...errors(404) },
});

function action(name: 'queue' | 'cancel' | 'retry' | 'approve', summary: string) {
  return createRoute({
    operationId: `${name}Task`,
    tags,
    method: 'post',
    path: `/api/tasks/{id}/${name}`,
    summary,
    request: {
      params,
      headers: MutationHeadersSchema,
      body: optionalBody(TaskActionRequestSchema),
    },
    responses: { 200: json(TaskResponseSchema, 'The updated task'), ...errors(404, 409) },
  });
}

export const queueTask = action('queue', 'Move a draft task to the queue');
export const cancelTask = action('cancel', 'Cancel a task (stops its live run)');
export const retryTask = action('retry', 'Retry a blocked or failed task');
export const approveTask = action('approve', 'Accept a task in review (human approval)');

export const rejectTask = createRoute({
  operationId: 'rejectTask',
  tags,
  method: 'post',
  path: '/api/tasks/{id}/reject',
  summary: 'Reject a task in review; the note becomes the fix run’s must-fix list',
  request: { params, headers: MutationHeadersSchema, body: body(TaskRejectRequestSchema) },
  responses: { 200: json(TaskResponseSchema, 'The updated task'), ...errors(404, 409) },
});

export const reassignTask = createRoute({
  operationId: 'reassignTask',
  tags,
  method: 'post',
  path: '/api/tasks/{id}/reassign',
  summary: 'Use another role for the next impl/fix run',
  request: { params, headers: MutationHeadersSchema, body: body(TaskReassignRequestSchema) },
  responses: { 200: json(TaskResponseSchema, 'The updated task'), ...errors(404, 409) },
});

export const taskRoutes = {
  listTasks,
  createTask,
  getTask,
  queueTask,
  cancelTask,
  retryTask,
  approveTask,
  rejectTask,
  reassignTask,
};
