import { z } from 'zod';
import { NonNegativeIntSchema, PositiveIntSchema } from './common.js';
import { ID_PREFIXES, ProjectIdSchema } from './ids.js';

// Project memory (spec §18; docs/adr/0023): items stored in an existing MemOS server, one cube per
// project. Only the service writes (from verified sources, through the effect table); workers
// get matching items as a data block in their prompt; the leader may search.

export const MEMORY_SOURCES = ['task', 'decision', 'human', 'research'] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/** Board/CLI labels of each source (research text came from web pages). */
export const MEMORY_SOURCE_LABEL: Record<MemorySource, string> = {
  task: '任務完成',
  decision: '人的決定',
  human: '手動加入',
  research: '調研（內容源自網頁）',
};

/**
 * Keys of the `info` object sent with every item. MemOS silently drops `info` keys that collide
 * with its own metadata fields (`source` is one of them) and its Neo4j backends flatten `info`
 * into node properties, so every key is namespaced (docs/adr/0023).
 */
export const MEMORY_INFO_KEYS = {
  source: 'team_source',
  source_id: 'team_source_id',
  task_id: 'team_task_id',
  project_id: 'team_project_id',
  at: 'team_at',
} as const;

/** A MemOS memory id (a UUID). Checked before it is sent anywhere. */
export const MemoryIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'expected a MemOS memory id (uuid)',
  );

/** One stored item as the service shows it (search hit or list entry). */
export const MemoryItemSchema = z.object({
  id: MemoryIdSchema,
  text: z.string(),
  /**
   * Which verified source wrote it; null = the item carries no agent-team source (MemOS may
   * rewrite items after an async add): show and treat it as unverified, like research.
   */
  source: MemorySourceSchema.nullable(),
  /** Task, attention item or note id the item was written for. */
  source_id: z.string().nullable(),
  task_id: z.string().nullable(),
  /** When the service composed it (`info`), else MemOS's own creation time. */
  created_at: z.string().nullable(),
  /**
   * false = MemOS stored it without a vector, so search never finds it (MemOS issue #2461);
   * null = MemOS did not say.
   */
  searchable: z.boolean().nullable(),
  /** Search relevance (0–1); null outside search results. */
  relativity: z.number().nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

/** Characters of the cube prefix: it is the only guard against touching other MemOS data. */
export const MEMORY_CUBE_PREFIX_RE = /^[a-z][a-z0-9-]{2,38}-$/;

/** A project's cube: `<cube_prefix><project_id>` (spec §18). */
export function memoryCubeId(prefix: string, projectId: string): string {
  if (!MEMORY_CUBE_PREFIX_RE.test(prefix)) throw new Error(`invalid memory cube prefix ${prefix}`);
  if (!ProjectIdSchema.safeParse(projectId).success) {
    throw new Error(`invalid project id ${projectId}`);
  }
  return `${prefix}${projectId}`;
}

/** True when `cubeId` is a project cube under `prefix` (and nothing else). */
export function isProjectMemoryCube(prefix: string, cubeId: string): boolean {
  if (!MEMORY_CUBE_PREFIX_RE.test(prefix) || !cubeId.startsWith(prefix)) return false;
  const rest = cubeId.slice(prefix.length);
  return rest.startsWith(ID_PREFIXES.project) && ProjectIdSchema.safeParse(rest).success;
}

// ---------------------------------------------------------------------- api

const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** `{ id }` of the project plus the memory id (`POST …/memory/:memory_id/delete`). */
export const MemoryParamsSchema = z.object({ id: ProjectIdSchema, memory_id: MemoryIdSchema });

/** GET /projects/:id/memory/search?q=&limit= (`team memory search`; the leader may call it). */
export const MemorySearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(2000),
  limit: queryInt(1, 20).optional(),
});
export const MemorySearchResponseSchema = z.object({
  project_id: ProjectIdSchema,
  memories: z.array(MemoryItemSchema),
});
export type MemorySearchResponse = z.infer<typeof MemorySearchResponseSchema>;

/** GET /projects/:id/memory?page=&page_size= (humans only). Newest first. */
export const MemoryListQuerySchema = z.object({
  page: queryInt(1, 100000).default(1),
  page_size: queryInt(1, 100).default(20),
});
export const MemoryListResponseSchema = z.object({
  project_id: ProjectIdSchema,
  memories: z.array(MemoryItemSchema),
  total: NonNegativeIntSchema,
  page: PositiveIntSchema,
  page_size: PositiveIntSchema,
});
export type MemoryListResponse = z.infer<typeof MemoryListResponseSchema>;

/** POST /projects/:id/memory (humans only): queued as a `memory.write` effect. */
export const MemoryAddRequestSchema = z.object({ text: z.string().trim().min(1).max(8000) });
export type MemoryAddRequest = z.input<typeof MemoryAddRequestSchema>;
export const MemoryAddResponseSchema = z.object({
  project_id: ProjectIdSchema,
  /** The note id the write is keyed by (`n_…`). */
  source_id: z.string(),
  queued: z.literal(true),
});
export type MemoryAddResponse = z.infer<typeof MemoryAddResponseSchema>;

/** POST /projects/:id/memory/:memory_id/delete (humans only). */
export const MemoryRemoveResponseSchema = z.object({
  project_id: ProjectIdSchema,
  memory_id: MemoryIdSchema,
  removed: z.literal(true),
});
export type MemoryRemoveResponse = z.infer<typeof MemoryRemoveResponseSchema>;
