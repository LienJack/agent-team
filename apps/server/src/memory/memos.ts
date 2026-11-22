import type { KvRepository, Logger, MemoryPort, MemoryWrite } from '@agent-team/core';
import {
  MEMORY_INFO_KEYS,
  MemoryIdSchema,
  MemorySourceSchema,
  memoryCubeId,
  type MemoryItem,
  type MemorySettings,
} from '@agent-team/schema';
import { createMemosTransport, MemosError, type FetchLike } from './memos-http.js';

// The project-memory port over MemOS's REST API (spec §18; docs/adr/0023; request and response
// shapes checked against MemOS v2.0.36, commit 3a16e5f). One cube per project, always named
// explicitly; a fixed `user_id`; search `mode: fast`. Facts of that server this relies on:
// - `delete_memory` by id is not scoped to a cube, so a delete first proves the id is in the
//   project's cube with a cube-scoped `get_memory`, then checks the item is gone;
// - `info` keys that collide with its metadata fields are dropped, and Neo4j flattens `info`
//   into the node, so keys are namespaced and read from `metadata` and `metadata.info`;
// - an async add answers with ids the scheduler later replaces, so ids from `add` are not kept;
// - `create_cube` only registers the cube (add and search never consult it) and refuses an
//   owner it does not know: it is attempted once per cube and its outcome remembered in kv.

/** Writes include an embedding call on the server: they get longer than reads. */
export const MEMOS_WRITE_TIMEOUT_MS = 30_000;

const CUBE_KEY = (cube: string) => `memory:cube:${cube}`;

/** Text memory types an item of ours can have (preference, tool and skill memory are not). */
const TEXT_TYPES = new Set(['LongTermMemory', 'UserMemory', 'WorkingMemory', 'OuterMemory']);

export interface MemosMemoryOptions {
  settings: MemorySettings;
  kv: KvRepository;
  logger: Logger;
  fetch?: FetchLike;
}

export interface MemosMemory extends MemoryPort {
  /** `GET /health` for `team doctor`: never throws; `detail` carries no address. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A metadata field of ours, flattened by Neo4j or still under `info`. */
function infoField(metadata: Json, key: string): string | null {
  const info = isObject(metadata['info']) ? metadata['info'] : {};
  return str(metadata[key]) ?? str(info[key]);
}

/** The text without the role prefix MemOS's fast reader adds (`user: …`). */
function plainText(memory: string): string {
  return memory.replace(/^(?:user|assistant|system): (?:\[[^\]]*\]: )?/, '').trim();
}

/** One MemOS node → a MemoryItem (null when it is not a text memory of ours). */
export function toMemoryItem(node: unknown): MemoryItem | null {
  if (!isObject(node)) return null;
  const id = str(node['id']);
  if (id === null || !MemoryIdSchema.safeParse(id).success) return null;
  const metadata = isObject(node['metadata']) ? node['metadata'] : {};
  const type = str(metadata['memory_type']);
  if (type !== null && !TEXT_TYPES.has(type)) return null;
  const source = MemorySourceSchema.safeParse(infoField(metadata, MEMORY_INFO_KEYS.source));
  const sync = str(metadata['vector_sync']);
  const relativity = metadata['relativity'];
  return {
    id,
    text: plainText(typeof node['memory'] === 'string' ? node['memory'] : ''),
    source: source.success ? source.data : null,
    source_id: infoField(metadata, MEMORY_INFO_KEYS.source_id),
    task_id: infoField(metadata, MEMORY_INFO_KEYS.task_id),
    created_at: infoField(metadata, MEMORY_INFO_KEYS.at) ?? str(metadata['created_at']),
    searchable: sync === null ? null : sync === 'success',
    relativity: typeof relativity === 'number' ? relativity : null,
  };
}

/** The `memories` of the `text_mem` buckets of `cube` (other cubes' buckets are ignored). */
function bucketNodes(data: unknown, cube: string): { nodes: unknown[]; total: number | null } {
  const buckets = isObject(data) && Array.isArray(data['text_mem']) ? data['text_mem'] : [];
  const nodes: unknown[] = [];
  let total: number | null = null;
  for (const bucket of buckets) {
    if (!isObject(bucket) || bucket['cube_id'] !== cube) continue;
    if (Array.isArray(bucket['memories'])) nodes.push(...bucket['memories']);
    if (typeof bucket['total_nodes'] === 'number') total = (total ?? 0) + bucket['total_nodes'];
  }
  return { nodes, total };
}

/** Items in order, without repeats (a WorkingMemory copy has the same text as its item). */
function dedupe(items: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.id}|${item.text}`;
    if (seen.has(item.id) || seen.has(key)) return false;
    seen.add(item.id);
    seen.add(key);
    return true;
  });
}

export function createMemosMemory(options: MemosMemoryOptions): MemosMemory {
  const { settings, kv, logger } = options;
  const http = createMemosTransport({
    baseUrl: settings.base_url,
    cubePrefix: settings.cube_prefix,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const read = settings.timeout_ms;
  const cubeOf = (projectId: string) => memoryCubeId(settings.cube_prefix, projectId);

  /** Register the cube once (best effort: add and search do not depend on it). */
  async function ensureCube(cube: string): Promise<void> {
    if (kv.get(CUBE_KEY(cube)) !== undefined) return;
    try {
      await http.post(
        '/create_cube',
        { cube_id: cube, cube_name: cube, owner_id: settings.user_id },
        read,
      );
      kv.set(CUBE_KEY(cube), 'created');
    } catch (err) {
      if (err instanceof MemosError && err.status !== undefined) {
        // answered (unknown owner, or the cube exists already): not asked again
        kv.set(CUBE_KEY(cube), `refused:${err.status}`);
        logger.warn('MemOS did not register the memory cube (writes continue)', {
          status: err.status,
        });
        return;
      }
      throw err;
    }
  }

  /** Whether `memoryId` is a node of `cube` (a cube-scoped query; MemOS's by-id calls are not). */
  async function inCube(cube: string, memoryId: string): Promise<boolean> {
    const data = await http.post(
      '/get_memory',
      {
        mem_cube_id: cube,
        user_id: settings.user_id,
        filter: { and: [{ id: memoryId }] },
        page: 1,
        page_size: 1,
        include_preference: false,
        include_tool_memory: false,
        include_skill_memory: false,
      },
      read,
    );
    return bucketNodes(data, cube).nodes.some((n) => isObject(n) && n['id'] === memoryId);
  }

  return {
    async search(projectId, query, limit) {
      const cube = cubeOf(projectId);
      const data = await http.post(
        '/search',
        {
          query,
          user_id: settings.user_id,
          readable_cube_ids: [cube],
          mode: 'fast',
          top_k: limit,
          relativity: settings.relativity,
          include_preference: false,
          search_tool_memory: false,
          include_skill_memory: false,
        },
        read,
      );
      const items = bucketNodes(data, cube).nodes.map(toMemoryItem);
      return dedupe(items.filter((i): i is MemoryItem => i !== null)).slice(0, limit);
    },

    async add(projectId, item: MemoryWrite) {
      const cube = cubeOf(projectId);
      await ensureCube(cube);
      const info: Record<string, string> = {
        [MEMORY_INFO_KEYS.source]: item.source,
        [MEMORY_INFO_KEYS.source_id]: item.sourceId,
        [MEMORY_INFO_KEYS.project_id]: projectId,
        [MEMORY_INFO_KEYS.at]: item.at,
        ...(item.taskId === null ? {} : { [MEMORY_INFO_KEYS.task_id]: item.taskId }),
      };
      const data = await http.post(
        '/add',
        {
          user_id: settings.user_id,
          writable_cube_ids: [cube],
          messages: [{ role: 'user', content: item.text }],
          ...(settings.add_mode === 'sync_fast'
            ? { async_mode: 'sync', mode: 'fast' }
            : { async_mode: 'async' }),
          info,
        },
        MEMOS_WRITE_TIMEOUT_MS,
      );
      const written = Array.isArray(data) ? data : [];
      if (written.some((w) => isObject(w) && w['cube_id'] !== undefined && w['cube_id'] !== cube)) {
        throw new MemosError('MemOS /product/add wrote outside the project cube');
      }
    },

    async list(projectId, page) {
      const cube = cubeOf(projectId);
      const data = await http.post(
        '/get_memory',
        {
          mem_cube_id: cube,
          user_id: settings.user_id,
          page: page.page,
          page_size: page.pageSize,
          include_preference: false,
          include_tool_memory: false,
          include_skill_memory: false,
        },
        read,
      );
      const { nodes, total } = bucketNodes(data, cube);
      const items = dedupe(nodes.map(toMemoryItem).filter((i): i is MemoryItem => i !== null));
      return { items, total: total ?? items.length };
    },

    async remove(projectId, memoryId) {
      if (!MemoryIdSchema.safeParse(memoryId).success) return false;
      const cube = cubeOf(projectId);
      if (!(await inCube(cube, memoryId))) return false;
      const data = await http.post(
        '/delete_memory',
        { memory_ids: [memoryId], writable_cube_ids: [cube], auto_cleanup_working: true },
        read,
      );
      // MemOS answers 200 with `status: failure` when it could not delete
      if (!isObject(data) || data['status'] !== 'success') {
        throw new MemosError('MemOS /product/delete_memory reported a failure');
      }
      if (await inCube(cube, memoryId)) {
        throw new MemosError('MemOS still lists the item after deleting it');
      }
      return true;
    },

    async health() {
      try {
        const body = await http.health(read);
        const ok = body.status === 'healthy';
        const version = typeof body.version === 'string' ? ` (MemOS ${body.version})` : '';
        return { ok, detail: `${ok ? 'healthy' : `status ${String(body.status)}`}${version}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
