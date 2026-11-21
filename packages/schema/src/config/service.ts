import { z } from 'zod';

/** 0 = let the OS pick a free port (tests, ephemeral instances). */
const port = z.number().int().min(0).max(65535);
const ms = z.number().int().positive();

/**
 * `config/service.json` (spec §4, §8, §10, §11). Every field has a default, so `{}` is valid.
 * Values not fixed by the spec are documented in docs/adr/0005.
 */
export const ServiceConfigSchema = z.strictObject({
  /** Local listener for CLI/MCP (Bearer token from listener.json). */
  local: z
    .strictObject({
      host: z.string().default('127.0.0.1'),
      port: port.default(4517),
    })
    .prefault({}),
  /** LAN listener for the board (password → session cookie). */
  lan: z
    .strictObject({
      enabled: z.boolean().default(true),
      host: z.string().default('0.0.0.0'),
      port: port.default(4518),
      /** Extra allowed `Origin` values besides the listener's own origin. */
      allowed_origins: z.array(z.string()).default([]),
      lockout_failures: z.number().int().positive().default(5),
      lockout_minutes: z.number().int().positive().default(15),
      session_hours: z.number().int().positive().default(168),
    })
    .prefault({}),
  /** Grok bridge / hub (spec §10). Off by default: the existing hub session watches the inbox. */
  grok: z
    .strictObject({
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  /** Service-side commits (spec §6 step 5). */
  git: z
    .strictObject({
      author: z
        .strictObject({
          name: z
            .string()
            .regex(/^[^<>\n]+$/, 'a plain name (no <, > or newlines)')
            .default('agent-team'),
          email: z
            .string()
            .regex(/^[^\s<>@]+@[^\s<>@]+$/, 'an address like name@host')
            .default('agent-team@localhost'),
        })
        .prefault({}),
    })
    .prefault({}),
  paths: z
    .strictObject({
      /** `~` is expanded by the server. */
      worktree_root: z.string().default('~/RanoLabs/worktrees'),
    })
    .prefault({}),
  engine: z
    .strictObject({
      /** Patrol interval (spec §8: every few seconds). */
      tick_ms: ms.default(5000),
      /** Global cap on concurrent runs, including the reserved human slots. */
      max_concurrent_runs: z.number().int().positive().default(6),
      /** Slots only human-triggered actions may use (spec §8). */
      reserved_human_slots: z.number().int().nonnegative().default(1),
      /** Failed attempts before a task becomes `failed`. */
      max_attempts: z.number().int().positive().default(3),
      retry_initial_ms: ms.default(5000),
      retry_max_ms: ms.default(300000),
      /** Cooldown after a rate limit without `resetsAt` (spec §8: 15 minutes). */
      rate_limit_cooldown_ms: ms.default(900000),
      /** Consecutive runner failures that open the circuit (spec §8: 3). */
      circuit_failure_threshold: z.number().int().positive().default(3),
      circuit_open_ms: ms.default(600000),
      run_timeout_ms: ms.default(3600000),
      check_timeout_ms: ms.default(900000),
      /** Effect attempts before it is dropped as dead. */
      effect_max_attempts: z.number().int().positive().default(10),
      /** Remove worktrees of finished tasks after this many hours (spec §8: 72). */
      worktree_retention_hours: z.number().int().positive().default(72),
    })
    .prefault({}),
  leader: z
    .strictObject({
      /** Send `/compact` above this many context tokens (spec §9). */
      compact_threshold_tokens: z.number().int().positive().default(60000),
    })
    .prefault({}),
  sse: z
    .strictObject({
      heartbeat_ms: ms.default(15000),
      /** Per-connection queue limit; overflow drops only that connection. */
      max_queue: z.number().int().positive().default(1000),
    })
    .prefault({}),
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type EngineSettings = ServiceConfig['engine'];

export function parseServiceConfig(json: unknown): ServiceConfig {
  return ServiceConfigSchema.parse(json);
}

/** Fully defaulted service config. */
export function defaultServiceConfig(): ServiceConfig {
  return ServiceConfigSchema.parse({});
}
