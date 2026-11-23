import { z } from 'zod';
import { IsoDateTimeSchema, ShaSchema } from '../common.js';
import { OwnedPathSchema } from '../domain.js';
import { GateIdSchema, ProjectIdSchema } from '../ids.js';

// The gate (spec §19; docs/adr/0026): spec §6 steps 3–5 for a worktree the service did not
// create (a T3 Code delegate's). Humans only; jobs live in memory.

/** POST /api/gate */
export const GateRequestSchema = z.object({
  project_id: ProjectIdSchema,
  /** Absolute path of the worktree to check (symlinks are resolved). */
  worktree_path: z.string().min(1).max(4096),
  /** The commit the worker started from; must be an ancestor of HEAD. */
  base_sha: ShaSchema,
  owned_paths: z.array(OwnedPathSchema).min(1),
  /** Default `team(gate): <branch>`. */
  commit_message: z.string().trim().min(1).max(2000).optional(),
  /** Commit the verified uncommitted changes (default true). */
  commit: z.boolean().default(true),
});
export type GateRequest = z.input<typeof GateRequestSchema>;

export const GateStateSchema = z.enum(['running', 'done']);
export const GateVerdictSchema = z.enum(['pass', 'rejected', 'checks_failed']);
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export const GateCheckSchema = z.object({
  name: z.string(),
  cmd: z.string(),
  result: z.enum(['pass', 'fail', 'not_run']),
  /** Last 20 lines of the output (redacted); the full log is under DATA/gate/<gate_id>/. */
  tail: z.string(),
});
export type GateCheck = z.infer<typeof GateCheckSchema>;

/** GET /api/gate/{id} */
export const GateJobSchema = z.object({
  gate_id: GateIdSchema,
  project_id: ProjectIdSchema,
  worktree_path: z.string(),
  state: GateStateSchema,
  /** Set once `state` is `done`. */
  verdict: GateVerdictSchema.optional(),
  reasons: z.array(z.string()),
  /** base_sha..HEAD ∪ uncommitted ∪ untracked (not ignored), sorted. */
  files_changed: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  checks: z.array(GateCheckSchema),
  /** HEAD after the gate (the new commit when `committed`). */
  head_sha: ShaSchema.optional(),
  committed: z.boolean(),
  started_at: IsoDateTimeSchema,
  ended_at: IsoDateTimeSchema.optional(),
});
export type GateJob = z.infer<typeof GateJobSchema>;

/** 202 of POST /api/gate */
export const GateStartResponseSchema = z.object({
  gate_id: GateIdSchema,
  state: z.literal('running'),
});
