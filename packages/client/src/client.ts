import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { ACTOR_HEADER } from '@agent-team/protocol/constants';
import createClient, { type Client } from 'openapi-fetch';
import { connectionError, errorFromResponse, TeamApiError } from './errors.js';
import { subscribeEvents, type EventStreamOptions, type EventSubscription } from './events.js';
import type { components, operations, paths } from './generated/index.js';

type Schemas = components['schemas'];
type Json<Op extends keyof operations, S extends number = 200> = operations[Op] extends {
  responses: { [K in S]: { content: { 'application/json': infer B } } };
}
  ? B
  : never;
type Body<Op extends keyof operations> = operations[Op] extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : never;
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export type Project = Schemas['Project'];
export type Task = Schemas['Task'];
export type Run = Schemas['Run'];
export type Workspace = Schemas['Workspace'];
export type Attention = Schemas['Attention'];
export type Message = Schemas['Message'];
export type RunnerStatus = Schemas['RunnerStatus'];
export type RunnerCapabilities = Schemas['RunnerCapabilities'];
export type StateSnapshot = Json<'getState'>;
export type TaskDetail = Json<'getTask'>;
export type RunLog = Json<'getRunLog'>;
export type LeaderReply = Json<'postLeaderMessage'>;
export type LeaderReset = Json<'resetLeader'>;
export type Resume = Json<'getResume'>;
export type DoctorReport = Json<'getDoctor'>;
export type ProjectCreateBody = Body<'createProject'>;
export type TaskCreateBody = Body<'createTask'>;
export type LeaderMessageBody = Body<'postLeaderMessage'>;
export type AttentionCreateBody = Body<'createAttention'>;
export type AttentionAnswerBody = Body<'answerAttention'>;
export type TaskListQuery = Query<'listTasks'>;
export type AttentionListQuery = Query<'listAttention'>;
export type LeaderMessagesQuery = Query<'listLeaderMessages'>;
export type SimpleTaskAction = 'queue' | 'cancel' | 'retry' | 'approve';

export interface TeamClientOptions {
  /** Listener base URL, e.g. `http://127.0.0.1:4517` (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token of the local listener (from listener.json). Omit on the LAN (cookie). */
  token?: string;
  /** Mark calls as made by the leader (local listener; ADR 0005 actor). */
  actor?: 'leader';
  /** `fetch` to use (tests, custom agents). */
  fetch?: (input: Request) => Promise<Response>;
  /** Browser: `same-origin` sends the LAN session cookie. */
  credentials?: RequestInit['credentials'];
  /** Retries after a connection failure (same Idempotency-Key, so replays are safe). */
  retries?: number;
  /** Idempotency-Key factory (default: `crypto.randomUUID()`). */
  newKey?: () => string;
}

/** Typed wrapper over the API (spec §11). Every method throws `TeamApiError` on failure. */
export interface TeamClient {
  readonly baseUrl: string;
  /** The underlying openapi-fetch client (typed by the generated `paths`). */
  readonly raw: Client<paths>;
  state(): Promise<StateSnapshot>;
  listProjects(): Promise<Project[]>;
  createProject(body: ProjectCreateBody): Promise<Project>;
  listTasks(query?: TaskListQuery): Promise<Task[]>;
  createTask(body: TaskCreateBody): Promise<Task>;
  getTask(id: string): Promise<TaskDetail>;
  taskAction(id: string, action: SimpleTaskAction, reason?: string): Promise<Task>;
  rejectTask(id: string, note: string): Promise<Task>;
  reassignTask(id: string, role: string): Promise<Task>;
  runLog(id: string, tail?: number): Promise<RunLog>;
  sendLeaderMessage(body: LeaderMessageBody): Promise<LeaderReply>;
  leaderMessages(query?: LeaderMessagesQuery): Promise<Message[]>;
  /** New leader conversation (local listener only; `team leader reset`). */
  resetLeader(): Promise<LeaderReset>;
  listAttention(query?: AttentionListQuery): Promise<Attention[]>;
  openAttention(body: AttentionCreateBody): Promise<Attention>;
  answerAttention(id: string, body: AttentionAnswerBody): Promise<Attention>;
  resume(): Promise<Resume>;
  quota(): Promise<RunnerStatus[]>;
  doctor(): Promise<DoctorReport>;
  /** LAN listener: exchange the password for the session cookie. */
  login(password: string): Promise<void>;
  /** SSE: replay after `after`, then live; reconnects with the last seq. */
  events(options: EventStreamOptions): EventSubscription;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function defaultKey(): string {
  return globalThis.crypto.randomUUID();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a client for one listener. */
export function createTeamClient(options: TeamClientOptions): TeamClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const baseFetch = options.fetch ?? ((req: Request) => globalThis.fetch(req));
  const retries = options.retries ?? 2;
  const newKey = options.newKey ?? defaultKey;

  // connection failures are retried with the same request (and so the same Idempotency-Key)
  const fetchWithRetry = async (request: Request): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const req = attempt < retries ? request.clone() : request;
      try {
        return await baseFetch(req);
      } catch (err) {
        if (attempt >= retries || request.signal.aborted) throw connectionError(baseUrl, err);
        await sleep(100 * 2 ** attempt);
      }
    }
  };

  const raw = createClient<paths>({
    baseUrl,
    fetch: fetchWithRetry,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  raw.use({
    onRequest({ request }) {
      if (options.token) request.headers.set('Authorization', `Bearer ${options.token}`);
      if (options.actor) request.headers.set(ACTOR_HEADER, options.actor);
      if (MUTATING.has(request.method) && !request.headers.has(IDEMPOTENCY_HEADER)) {
        request.headers.set(IDEMPOTENCY_HEADER, newKey());
      }
      return request;
    },
  });

  /** Unwrap an openapi-fetch result: data on 2xx, `TeamApiError` otherwise. */
  async function call<T>(
    run: () => Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<T> {
    let result: { data?: T; error?: unknown; response: Response };
    try {
      result = await run();
    } catch (err) {
      if (err instanceof TeamApiError) throw err;
      throw connectionError(baseUrl, err);
    }
    if (!result.response.ok) throw errorFromResponse(result.response.status, result.error);
    return result.data as T;
  }

  const byId = (id: string) => ({ params: { path: { id } } });

  return {
    baseUrl,
    raw,
    state: () => call(() => raw.GET('/api/state')),
    listProjects: async () => (await call(() => raw.GET('/api/projects'))).projects,
    createProject: async (body) => (await call(() => raw.POST('/api/projects', { body }))).project,
    listTasks: async (query = {}) =>
      (await call(() => raw.GET('/api/tasks', { params: { query } }))).tasks,
    createTask: async (body) => (await call(() => raw.POST('/api/tasks', { body }))).task,
    getTask: (id) => call(() => raw.GET('/api/tasks/{id}', byId(id))),
    taskAction: async (id, action, reason) => {
      const init = { ...byId(id), body: reason === undefined ? {} : { reason } };
      const path = `/api/tasks/{id}/${action}` as const;
      return (await call(() => raw.POST(path, init))).task;
    },
    rejectTask: async (id, note) =>
      (await call(() => raw.POST('/api/tasks/{id}/reject', { ...byId(id), body: { note } }))).task,
    reassignTask: async (id, role) =>
      (await call(() => raw.POST('/api/tasks/{id}/reassign', { ...byId(id), body: { role } })))
        .task,
    runLog: (id, tail) =>
      call(() =>
        raw.GET('/api/runs/{id}/log', {
          params: { path: { id }, query: tail === undefined ? {} : { tail } },
        }),
      ),
    sendLeaderMessage: (body) => call(() => raw.POST('/api/leader/messages', { body })),
    leaderMessages: async (query = {}) =>
      (await call(() => raw.GET('/api/leader/messages', { params: { query } }))).messages,
    resetLeader: () => call(() => raw.POST('/api/leader/reset')),
    listAttention: async (query = {}) =>
      (await call(() => raw.GET('/api/attention', { params: { query } }))).attention,
    openAttention: async (body) =>
      (await call(() => raw.POST('/api/attention', { body }))).attention,
    answerAttention: async (id, body) =>
      (await call(() => raw.POST('/api/attention/{id}/answer', { ...byId(id), body }))).attention,
    resume: () => call(() => raw.GET('/api/resume')),
    quota: async () => (await call(() => raw.GET('/api/quota'))).runners,
    doctor: () => call(() => raw.GET('/api/doctor')),
    login: async (password) => {
      await call(() => raw.POST('/auth/login', { body: { password } }));
    },
    events: (eventOptions) =>
      subscribeEvents(
        {
          baseUrl,
          fetch: baseFetch,
          ...(options.token ? { token: options.token } : {}),
          ...(options.credentials ? { credentials: options.credentials } : {}),
        },
        eventOptions,
      ),
  };
}
