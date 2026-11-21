import type { ErrorCode, TaskStatus } from '@agent-team/schema';

/**
 * Base class of every error the engine and repositories throw on purpose. `code` maps 1:1 to the
 * API error envelope (`ERROR_HTTP_STATUS[code]`), so the server translates without guessing.
 */
export class TeamError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends TeamError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} not found`);
  }
}

export class ValidationError extends TeamError {
  constructor(message: string, hint?: string) {
    super('validation_failed', message, hint);
  }
}

export class ConflictError extends TeamError {
  constructor(message: string, hint?: string) {
    super('conflict', message, hint);
  }
}

/** A repository insert hit a unique key (id, dispatch_id, signature, client_msg_id, …). */
export class UniqueViolationError extends TeamError {
  constructor(
    readonly entity: string,
    readonly key: string,
  ) {
    super('conflict', `${entity} with ${key} already exists`);
  }
}

/**
 * A repository write referenced a row that does not exist (a foreign key: task → project,
 * parent task, current run; workspace/run/attention/outbox → task; run → workspace).
 */
export class ForeignKeyViolationError extends TeamError {
  constructor(
    readonly entity: string,
    readonly reference: string,
  ) {
    super('conflict', `${entity} references a missing ${reference}`);
  }
}

/** Optimistic lock failed: the stored row changed since it was read. */
export class VersionConflictError extends TeamError {
  constructor(entity: string, id: string, expected: number) {
    super('version_conflict', `${entity} ${id} changed (expected version ${expected})`);
  }
}

export class InvalidTransitionError extends TeamError {
  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super('invalid_transition', `task ${taskId} cannot go from ${from} to ${to}`);
  }
}

export class IdempotencyConflictError extends TeamError {
  constructor(requestId: string) {
    super(
      'idempotency_conflict',
      `Idempotency-Key ${requestId} was used with a different request`,
      'use a new Idempotency-Key for a different request',
    );
  }
}

export class RequestInProgressError extends TeamError {
  constructor(requestId: string) {
    super('request_in_progress', `request ${requestId} is still being processed`);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
