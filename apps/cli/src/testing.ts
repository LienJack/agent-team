// Test support: an in-memory CliIo and a fake TeamClient (only the methods a test provides).
import type { Task, TaskCommandResult, TeamClient } from '@agent-team/client';
import { deliveryOf, deliveryReport } from '@agent-team/schema';
import type { CliIo } from './io.js';

export interface CapturedIo extends CliIo {
  out: string[];
  err: string[];
  /** stdout joined */
  text(): string;
}

export function captureIo(
  client: TeamClient | (() => Promise<TeamClient>),
  extra: Partial<CliIo> = {},
): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => out.join(''),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    readStdin: async () => '',
    readFile: async (path) => {
      throw new Error(`no file ${path}`);
    },
    cwd: '/work',
    env: {},
    connect: typeof client === 'function' ? client : async () => client,
    serve: async () => 0,
    newMessageId: () => 'msg-1',
    ...extra,
  };
}

/** The reply a task command gives for `task` (no live run, waiting reason not known). */
export function commandResult(task: Task): TaskCommandResult {
  const delivery = deliveryOf({ task, liveRunId: null, waiting: null });
  return { task, delivery, report: deliveryReport(task, delivery) };
}

/**
 * A TeamClient whose unspecified methods throw (so tests see unexpected calls). The `…Result`
 * task commands fall back to the plain method a test gave (`createTask` → `createTaskResult`).
 */
export function fakeClient(methods: Partial<TeamClient>): TeamClient {
  const derived: Partial<TeamClient> = {};
  if (methods.createTask && !methods.createTaskResult) {
    const create = methods.createTask;
    derived.createTaskResult = async (b, o) => commandResult(await create(b, o));
  }
  if (methods.createResearch && !methods.createResearchResult) {
    const create = methods.createResearch;
    derived.createResearchResult = async (b, o) => commandResult(await create(b, o));
  }
  if (methods.taskAction && !methods.taskActionResult) {
    const act = methods.taskAction;
    derived.taskActionResult = async (id, a, r) => commandResult(await act(id, a, r));
  }
  return new Proxy({ ...derived, ...methods } as TeamClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof TeamClient];
      if (prop === 'then') return undefined;
      return () => {
        throw new Error(`unexpected client call ${prop}`);
      };
    },
  });
}
