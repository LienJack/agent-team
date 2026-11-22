import { isProjectMemoryCube } from '@agent-team/schema';

// Transport to MemOS (spec §18; docs/adr/0023). Every request goes through `post`/`get` here:
// one AbortSignal timeout per request, every cube id in the body checked against the prefix
// (the only thing between this service and other people's data on that server), the delete
// request stripped of its "quick delete" fields, and errors that name the path and status only —
// never the address, a request or a response body (they reach events, `team doctor` and logs).

/** The MemOS REST prefix. */
export const MEMOS_PREFIX = '/product';

/** A failed MemOS call; `message` is safe to show anywhere. */
export class MemosError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MemosError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MemosTransportOptions {
  baseUrl: string;
  cubePrefix: string;
  fetch?: FetchLike;
}

const CUBE_LIST_FIELDS = ['writable_cube_ids', 'readable_cube_ids'] as const;
const CUBE_FIELDS = ['mem_cube_id', 'cube_id'] as const;
/** Fields of `delete_memory` that select by user or session instead of by id: never sent. */
const DELETE_FORBIDDEN = [
  'user_id',
  'session_id',
  'conversation_id',
  'filter',
  'file_ids',
] as const;

/** Throw unless every cube id in `body` is a project cube under `prefix`. */
export function assertOwnCubes(prefix: string, path: string, body: Record<string, unknown>): void {
  const cubes: unknown[] = [];
  for (const field of CUBE_LIST_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0) {
      throw new MemosError(`refusing ${path}: ${field} must list the project's cube`);
    }
    cubes.push(...value);
  }
  for (const field of CUBE_FIELDS) if (body[field] !== undefined) cubes.push(body[field]);
  for (const cube of cubes) {
    if (typeof cube !== 'string' || !isProjectMemoryCube(prefix, cube)) {
      throw new MemosError(`refusing ${path}: cube ${String(cube)} is not one of this service's`);
    }
  }
  const scoped: Record<string, readonly string[]> = {
    '/add': ['writable_cube_ids'],
    '/search': ['readable_cube_ids'],
    '/get_memory': ['mem_cube_id'],
    '/create_cube': ['cube_id'],
    '/delete_memory': ['writable_cube_ids'],
  };
  for (const field of scoped[path] ?? []) {
    if (body[field] === undefined) throw new MemosError(`refusing ${path}: no explicit ${field}`);
  }
  if (path === '/delete_memory') {
    for (const field of DELETE_FORBIDDEN) {
      if (body[field] !== undefined) throw new MemosError(`refusing ${path}: ${field} is not sent`);
    }
    const ids = body['memory_ids'];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new MemosError(`refusing ${path}: only deletes by memory id`);
    }
  }
}

function describeFailure(path: string, err: unknown, timeoutMs: number): MemosError {
  if (err instanceof MemosError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new MemosError(`MemOS ${path} timed out after ${timeoutMs} ms`);
  }
  // undici: TypeError('fetch failed') with a system error as `cause` (its message has the address)
  const cause = err instanceof Error ? (err as { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : 'network error';
  return new MemosError(`MemOS ${path} unreachable (${code})`);
}

export interface MemosTransport {
  /** POST `MEMOS_PREFIX + path`; returns the `data` of the MemOS envelope. */
  post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  /** GET `/health` (outside the REST prefix). */
  health(timeoutMs: number): Promise<{ status?: unknown; version?: unknown }>;
}

export function createMemosTransport(options: MemosTransportOptions): MemosTransport {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw describeFailure(path, err, timeoutMs);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      if (!response.ok)
        throw new MemosError(`MemOS ${path} answered ${response.status}`, response.status);
      throw describeFailure(path, err, timeoutMs);
    }
    if (!response.ok)
      throw new MemosError(`MemOS ${path} answered ${response.status}`, response.status);
    return parsed;
  }

  return {
    async post(path, body, timeoutMs) {
      assertOwnCubes(options.cubePrefix, path, body);
      const full = `${MEMOS_PREFIX}${path}`;
      const parsed = (await send(
        full,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
      )) as { code?: unknown; data?: unknown } | null;
      if (parsed === null || typeof parsed !== 'object') {
        throw new MemosError(`MemOS ${full} answered no JSON object`);
      }
      if (parsed.code !== undefined && parsed.code !== 200) {
        throw new MemosError(`MemOS ${full} reported code ${String(parsed.code)}`);
      }
      return parsed.data;
    },
    async health(timeoutMs) {
      const parsed = await send('/health', { method: 'GET' }, timeoutMs);
      return (parsed ?? {}) as { status?: unknown; version?: unknown };
    },
  };
}
