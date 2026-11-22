import { redactSecrets, type MemoryItem } from '@agent-team/schema';
import {
  ConflictError,
  errorMessage,
  NotFoundError,
  TeamError,
  UnavailableError,
} from '../errors.js';
import type { MemoryPort } from '../ports/project-memory.js';
import { requireHuman, type Actor } from './commands.js';
import type { EngineContext } from './context.js';
import { enqueueMemoryWrite } from './project-memory.js';

// The entrances of the project memory (spec §18): `team memory search|add|list|rm`, the MCP tools
// and the board. The leader may search; adding, listing and deleting are human-only. Reads go
// straight to MemOS (nothing about them is stored); a person's note is queued like every write.

/** The memory port, or 409 while project memory is off. */
export function requireMemory(ctx: EngineContext, what: string): MemoryPort {
  const port = ctx.deps.memory;
  if (!ctx.config.memory.enabled || port === undefined) {
    throw new ConflictError(
      `${what}: project memory is off (service.json memory.enabled = false)`,
      'set memory.enabled to true and restart the service',
    );
  }
  return port;
}

function requireProject(ctx: EngineContext, projectId: string): void {
  if (!ctx.store.projects.get(projectId)) throw new NotFoundError('project', projectId);
}

/** MemOS failed: 503 with a message that never carries its address or response body. */
function unavailable(what: string, err: unknown): TeamError {
  if (err instanceof TeamError) return err;
  return new UnavailableError(
    `${what}: project memory is unavailable (${redactSecrets(errorMessage(err)).slice(0, 300)})`,
    'check `team doctor`; MemOS runs on the NAS',
  );
}

/** Search a project's memory (the leader may). `limit` defaults to `memory.top_k`. */
export async function searchProjectMemory(
  ctx: EngineContext,
  projectId: string,
  query: string,
  limit?: number,
): Promise<MemoryItem[]> {
  const port = requireMemory(ctx, 'searching project memory');
  requireProject(ctx, projectId);
  try {
    return await port.search(projectId, query, limit ?? ctx.config.memory.top_k);
  } catch (err) {
    throw unavailable('searching project memory', err);
  }
}

/** One page of a project's memory, newest first (humans only). */
export async function listProjectMemory(
  ctx: EngineContext,
  projectId: string,
  page: { page: number; pageSize: number },
  actor: Actor,
): Promise<{ items: MemoryItem[]; total: number }> {
  requireHuman(actor, 'listing project memory');
  const port = requireMemory(ctx, 'listing project memory');
  requireProject(ctx, projectId);
  try {
    return await port.list(projectId, page);
  } catch (err) {
    throw unavailable('listing project memory', err);
  }
}

/** Delete one item of a project's memory (humans only); 404 when it is not in that project. */
export async function removeProjectMemory(
  ctx: EngineContext,
  projectId: string,
  memoryId: string,
  actor: Actor,
): Promise<void> {
  requireHuman(actor, 'deleting project memory');
  const port = requireMemory(ctx, 'deleting project memory');
  requireProject(ctx, projectId);
  let removed: boolean;
  try {
    removed = await port.remove(projectId, memoryId);
  } catch (err) {
    throw unavailable('deleting project memory', err);
  }
  if (!removed) throw new NotFoundError(`memory item of project ${projectId}`, memoryId);
  ctx.transact((tx) => {
    tx.emit('memory.removed', { project_id: projectId, memory_id: memoryId });
  });
}

/**
 * `team memory add` (spec §18): a person's note, queued as a `memory.write` effect (source
 * `human`, keyed by a new note id) like every other write. Returns the note id.
 */
export function addMemoryNote(
  ctx: EngineContext,
  projectId: string,
  text: string,
  actor: Actor,
): string {
  requireHuman(actor, 'adding to project memory');
  requireMemory(ctx, 'adding to project memory');
  if (!ctx.config.memory.write_sources.human) {
    throw new ConflictError(
      'adding to project memory: notes are switched off (service.json memory.write_sources.human = false)',
    );
  }
  return ctx.transact((tx) => {
    if (!tx.r.projects.get(projectId)) throw new NotFoundError('project', projectId);
    const noteId = ctx.newId('note');
    if (
      !enqueueMemoryWrite(ctx, tx, {
        projectId,
        source: 'human',
        sourceId: noteId,
        taskId: null,
        text,
      })
    ) {
      throw new ConflictError('adding to project memory: the note is empty after redaction');
    }
    return noteId;
  });
}
