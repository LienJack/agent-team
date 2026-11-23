import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import createClient, { type Client } from 'openapi-fetch';
import { connectionError, errorFromResponse, TeamApiError } from './errors.js';
import { subscribeEvents, type EventStreamOptions, type EventSubscription } from './events.js';
import type { components, operations, paths } from './generated/index.js';
import { randomId } from './ids.js';

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
/** A task in the board snapshot: the task plus its latest run, head sha and run totals. */
export type BoardTask = Schemas['BoardTask'];
export type TaskRunSummary = NonNullable<BoardTask['latest_run']>;
export type Run = Schemas['Run'];
export type Workspace = Schemas['Workspace'];
export type Attention = Schemas['Attention'];
export type Message = Schemas['Message'];
export type RunnerStatus = Schemas['RunnerStatus'];
export type RunnerCapabilities = Schemas['RunnerCapabilities'];
export type StateSnapshot = Json<'getState'>;
/** Counts per board column that sum to `total`, and the generated line (docs/adr/0022). */
export type BoardSummary = Schemas['BoardSummary'];
/** What a task command did to the task's dispatch (running / queued / draft / done / not_accepted). */
export type Delivery = Schemas['Delivery'];
/** A task command's full reply: the task, its delivery and the one-line report to relay. */
export type TaskCommandResult = Json<'createTask', 201>;
export type TaskDetail = Json<'getTask'>;
/** GET /api/research/:id: the research task and its last accepted receipt (spec §17). */
export type ResearchDetail = Json<'getResearch'>;
export type ResearchReceipt = NonNullable<ResearchDetail['receipt']>;
export type RunLog = Json<'getRunLog'>;
export type LeaderReply = Json<'postLeaderMessage'>;
export type LeaderMessageDetail = Json<'getLeaderMessage'>;
export type LeaderStatusView = StateSnapshot['leader'];
export type RoleInfo = Json<'getRoles'>['roles'][number];
export type LeaderReset = Json<'resetLeader'>;
export type Resume = Json<'getResume'>;
export type DoctorReport = Json<'getDoctor'>;
export type ProjectCreateBody = Body<'createProject'>;
export type ProjectUpdateBody = Body<'updateProject'>;
export type TaskCreateBody = Body<'createTask'>;
export type ResearchCreateBody = Body<'createResearch'>;
export type LeaderMessageBody = Body<'postLeaderMessage'>;
export type AttentionCreateBody = Body<'createAttention'>;
export type AttentionAnswerBody = Body<'answerAttention'>;
export type TaskListQuery = Query<'listTasks'>;
export type AttentionListQuery = Query<'listAttention'>;
export type LeaderMessagesQuery = Query<'listLeaderMessages'>;
export type SimpleTaskAction = 'queue' | 'cancel' | 'retry' | 'approve';
/** Project memory (spec §18): search hits and list pages. */
export type MemorySearchResult = Json<'searchMemory'>;
export type MemoryItem = MemorySearchResult['memories'][number];
export type MemoryPage = Json<'listMemory'>;
export type MemoryAddResult = Json<'addMemory', 202>;
export type MemoryRemoveResult = Json<'removeMemory'>;
export type MemoryListQuery = Query<'listMemory'>;

export interface TeamClientOptions {
  /** Listener base URL, e.g. `http://127.0.0.1:4517` (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token of the local listener (from listener.json). Omit on the LAN (no credential). */
  token?: string;
  /** `fetch` to use (tests, custom agents). */
  fetch?: (input: Request) => Promise<Response>;
  /** `fetch` credentials mode (browser). */
  credentials?: RequestInit['credentials'];
  /**
   * Fresh `{ baseUrl, token }` for the event stream's reconnects (Node: listener.json read
   * again), so `events()` survives a service restart, which rotates the token.
   */
  refresh?: () => Promise<{ baseUrl: string; token?: string }>;
  /** Retries after a connection failure (same Idempotency-Key, so replays are safe). */
  retries?: number;
  /**
   * Idempotency-Key factory (default: `randomId()`, from `crypto.getRandomValues`, which also
   * exists on plain-HTTP LAN pages where `crypto.randomUUID` does not).
   */
  newKey?: () => string;
}

/** Per-call options of the long-running calls. */
export interface CallOptions {
  /** Abort the request (e.g. Ctrl-C while waiting for the leader). */
  signal?: AbortSignal;
}

/** Typed wrapper over the API (spec §11). Every method throws `TeamApiError` on failure. */
export interface TeamClient {
  readonly baseUrl: string;
  /** The underlying openapi-fetch client (typed by the generated `paths`). */
  readonly raw: Client<paths>;
  state(): Promise<StateSnapshot>;
  listProjects(): Promise<Project[]>;
  createProject(body: ProjectCreateBody): Promise<Project>;
  /** Replace a project's checks (humans only). */
  updateProject(id: string, body: ProjectUpdateBody): Promise<Project>;
  listTasks(query?: TaskListQuery): Promise<Task[]>;
  /**
   * `idempotencyKey`: a caller-chosen `Idempotency-Key` (the leader's `team task add` derives it
   * from its turn and the body, so a replayed turn cannot create the same task twice).
   */
  createTask(body: TaskCreateBody, options?: { idempotencyKey?: string }): Promise<Task>;
  /** `createTask` with the whole reply: the task, its `delivery` and the `report` line. */
  createTaskResult(
    body: TaskCreateBody,
    options?: { idempotencyKey?: string },
  ): Promise<TaskCommandResult>;
  getTask(id: string): Promise<TaskDetail>;
  /** A research task (spec §17); 409 while `research.mode` is off. `idempotencyKey` as above. */
  createResearch(body: ResearchCreateBody, options?: { idempotencyKey?: string }): Promise<Task>;
  /** `createResearch` with the whole reply (task, delivery, report). */
  createResearchResult(
    body: ResearchCreateBody,
    options?: { idempotencyKey?: string },
  ): Promise<TaskCommandResult>;
  /** A research task and its result (links not verified by the service). */
  getResearch(id: string): Promise<ResearchDetail>;
  taskAction(id: string, action: SimpleTaskAction, reason?: string): Promise<Task>;
  /** `taskAction` with the whole reply (task, delivery, report). */
  taskActionResult(
    id: string,
    action: SimpleTaskAction,
    reason?: string,
  ): Promise<TaskCommandResult>;
  rejectTask(id: string, note: string): Promise<Task>;
  reassignTask(id: string, role: string): Promise<Task>;
  runLog(id: string, tail?: number): Promise<RunLog>;
  /** Roles from config/models.json (what `reassignTask` accepts). */
  roles(): Promise<RoleInfo[]>;
  /**
   * POST /api/leader/messages. `wait: false` returns once stored (`pending: true`); the default
   * waits up to the server's cap. To wait for the reply however long it takes, use `askLeader`.
   */
  sendLeaderMessage(body: LeaderMessageBody, options?: CallOptions): Promise<LeaderReply>;
  /** One leader input and its reply (null while pending). */
  leaderMessage(id: string, options?: CallOptions): Promise<LeaderMessageDetail>;
  leaderMessages(query?: LeaderMessagesQuery): Promise<Message[]>;
  /** New leader conversation (`team leader reset`; humans only). */
  resetLeader(): Promise<LeaderReset>;
  listAttention(query?: AttentionListQuery): Promise<Attention[]>;
  openAttention(body: AttentionCreateBody): Promise<Attention>;
  answerAttention(id: string, body: AttentionAnswerBody): Promise<Attention>;
  resume(): Promise<Resume>;
  quota(): Promise<RunnerStatus[]>;
  doctor(): Promise<DoctorReport>;
  /** Search a project's memory (spec §18; the leader may). 409 while memory is off. */
  searchMemory(projectId: string, query: string, limit?: number): Promise<MemorySearchResult>;
  /** One page of a project's memory, newest first (humans only). */
  listMemory(projectId: string, query?: MemoryListQuery): Promise<MemoryPage>;
  /** Queue a note for a project's memory (humans only). */
  addMemory(projectId: string, text: string): Promise<MemoryAddResult>;
  /** Delete one item of a project's memory (humans only). */
  removeMemory(projectId: string, memoryId: string): Promise<MemoryRemoveResult>;
  /** SSE: replay after `after`, then live; reconnects with the last seq. */
  events(options: EventStreamOptions): EventSubscription;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a client for one listener. */
export function createTeamClient(options: TeamClientOptions): TeamClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const baseFetch = options.fetch ?? ((req: Request) => globalThis.fetch(req));
  const retries = options.retries ?? 2;
  const newKey = options.newKey ?? (() => randomId());

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
  const keyed = (key: string | undefined) =>
    key === undefined ? {} : { headers: { [IDEMPOTENCY_HEADER]: key } };

  const createTaskResult: TeamClient['createTaskResult'] = (body, callOptions) =>
    call(() => raw.POST('/api/tasks', { body, ...keyed(callOptions?.idempotencyKey) }));
  const createResearchResult: TeamClient['createResearchResult'] = (body, callOptions) =>
    call(() => raw.POST('/api/research', { body, ...keyed(callOptions?.idempotencyKey) }));
  const taskActionResult: TeamClient['taskActionResult'] = (id, action, reason) => {
    const init = { ...byId(id), body: reason === undefined ? {} : { reason } };
    const path = `/api/tasks/{id}/${action}` as const;
    return call(() => raw.POST(path, init));
  };

  return {
    baseUrl,
    raw,
    state: () => call(() => raw.GET('/api/state')),
    listProjects: async () => (await call(() => raw.GET('/api/projects'))).projects,
    createProject: async (body) => (await call(() => raw.POST('/api/projects', { body }))).project,
    updateProject: async (id, body) =>
      (await call(() => raw.PATCH('/api/projects/{id}', { ...byId(id), body }))).project,
    listTasks: async (query = {}) =>
      (await call(() => raw.GET('/api/tasks', { params: { query } }))).tasks,
    createTask: async (body, callOptions) => (await createTaskResult(body, callOptions)).task,
    createTaskResult,
    getTask: (id) => call(() => raw.GET('/api/tasks/{id}', byId(id))),
    createResearch: async (body, callOptions) =>
      (await createResearchResult(body, callOptions)).task,
    createResearchResult,
    getResearch: (id) => call(() => raw.GET('/api/research/{id}', byId(id))),
    taskAction: async (id, action, reason) => (await taskActionResult(id, action, reason)).task,
    taskActionResult,
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
    roles: async () => (await call(() => raw.GET('/api/roles'))).roles,
    sendLeaderMessage: (body, callOptions = {}) =>
      call(() =>
        raw.POST('/api/leader/messages', {
          body,
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        }),
      ),
    leaderMessage: (id, callOptions = {}) =>
      call(() =>
        raw.GET('/api/leader/messages/{id}', {
          ...byId(id),
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        }),
      ),
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
    searchMemory: (projectId, q, limit) =>
      call(() =>
        raw.GET('/api/projects/{id}/memory/search', {
          params: { path: { id: projectId }, query: limit === undefined ? { q } : { q, limit } },
        }),
      ),
    listMemory: (projectId, query = {}) =>
      call(() =>
        raw.GET('/api/projects/{id}/memory', { params: { path: { id: projectId }, query } }),
      ),
    addMemory: (projectId, text) =>
      call(() =>
        raw.POST('/api/projects/{id}/memory', {
          params: { path: { id: projectId } },
          body: { text },
        }),
      ),
    removeMemory: (projectId, memoryId) =>
      call(() =>
        raw.POST('/api/projects/{id}/memory/{memory_id}/delete', {
          params: { path: { id: projectId, memory_id: memoryId } },
        }),
      ),
    events: (eventOptions) =>
      subscribeEvents(
        {
          baseUrl,
          fetch: baseFetch,
          ...(options.token ? { token: options.token } : {}),
          ...(options.credentials ? { credentials: options.credentials } : {}),
          ...(options.refresh ? { refresh: options.refresh } : {}),
        },
        eventOptions,
      ),
  };
}
