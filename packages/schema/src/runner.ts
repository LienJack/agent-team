import { z } from 'zod';
import {
  EffortSchema,
  IsoDateTimeSchema,
  JsonSchemaSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  RunnerNameSchema,
} from './common.js';

// Runner contract (spec §7). These are TypeScript-facing shapes and use camelCase like the spec;
// persisted/wire shapes elsewhere use snake_case (see docs/conventions.md).

/** Token usage reported by a run (persisted on `run.usage`, hence snake_case). */
export const UsageSchema = z.object({
  input_tokens: NonNegativeIntSchema.optional(),
  output_tokens: NonNegativeIntSchema.optional(),
  cache_read_tokens: NonNegativeIntSchema.optional(),
  cache_write_tokens: NonNegativeIntSchema.optional(),
  reasoning_tokens: NonNegativeIntSchema.optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

/**
 * Everything a runner needs for one run. The spec is persisted in the effect table before the
 * run starts, so it must never contain secrets: runners obtain credentials themselves (injected
 * by the server wiring) and put only the one variable they need into the child environment.
 */
export const RunSpecSchema = z.object({
  /** Fencing token; the receipt must echo it. */
  dispatchId: z.string().min(1),
  /** Absolute worktree path the worker runs in. */
  cwd: z.string().min(1),
  prompt: z.string(),
  /** JSON Schema of the receipt (see `receiptJsonSchema`). */
  schema: JsonSchemaSchema,
  /** Concrete model id (not the alias). */
  model: z.string().min(1),
  effort: EffortSchema.optional(),
  /** false = read-only tools only (review runs). */
  writable: z.boolean(),
  /**
   * Research run (spec §17): web search and fetch tools only — no file or shell tool, `cwd` is an
   * empty directory, never the repository. Only runners whose probe reports
   * `supports.webSearch` accept it; others refuse. Missing (older specs) = false.
   */
  web: z.boolean().optional(),
  /** Absolute `DATA/runs/<run_id>` directory for events.jsonl, stderr.log, prompt.md. */
  logDir: z.string().min(1),
  timeoutMs: PositiveIntSchema,
  /** Extra non-secret environment for the child process. */
  env: z.record(z.string(), z.string()).optional(),
  /** Session to resume (only for runners implementing `Resumable`). */
  resumeRef: z.string().optional(),
  /**
   * Per-run sandbox facts (docs/adr/0014). The runner adds the service-wide deny list (DATA, the
   * service `.env`, credential directories) it was built with. Missing (a spec stored by an older
   * version) = the strictest policy: no network, no repository paths.
   */
  sandbox: z
    .object({
      /** Project setting `allow_network` (never this machine's own addresses). */
      allowNetwork: z.boolean(),
      /** Primary checkout: its `.git` is readable (worktree git data), its `.env` is not. */
      repoPath: z.string().min(1).optional(),
    })
    .optional(),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;
export type RunSandbox = NonNullable<RunSpec['sandbox']>;

/**
 * Error kinds a runner reports. `start_unknown` = cannot tell whether the agent started (the
 * engine never resends automatically). `cancelled` (not in spec §7) = the run's AbortSignal fired.
 */
export const RunErrorKindSchema = z.enum([
  'rate_limit',
  'auth',
  'timeout',
  'crash',
  'bad_output',
  'start_unknown',
  'cancelled',
]);
export type RunErrorKind = z.infer<typeof RunErrorKindSchema>;

export const RunQuotaSchema = z.object({
  /** 0..1 share of the subscription window already used. */
  utilization: z.number().min(0).max(1).optional(),
  resetsAt: IsoDateTimeSchema.optional(),
  exhausted: z.boolean().optional(),
});
export type RunQuota = z.infer<typeof RunQuotaSchema>;

/** Outcome of `Runner.run`. Runners resolve (never reject) with `error` set on failure. */
export const RunResultSchema = z.object({
  /** The worker's final structured answer (the receipt candidate). */
  final: z.unknown().optional(),
  usage: UsageSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  sessionRef: z.string().optional(),
  error: z
    .object({
      kind: RunErrorKindSchema,
      message: z.string(),
    })
    .optional(),
  quota: RunQuotaSchema.optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** Reported through `RunHooks.onStarted` once the agent process is known to be running. */
export const RunStartedInfoSchema = z.object({
  pid: PositiveIntSchema.optional(),
  /** OS start time of `pid` (`ps -o lstart`), when known. */
  pidStartedAt: z.string().optional(),
  sessionRef: z.string().optional(),
});
export type RunStartedInfo = z.infer<typeof RunStartedInfoSchema>;

/** Reported through `RunHooks.onSpawned` right after the worker process exists. */
export const RunSpawnInfoSchema = z.object({
  pid: PositiveIntSchema,
  pidStartedAt: z.string().optional(),
});
export type RunSpawnInfo = z.infer<typeof RunSpawnInfoSchema>;

/** What `Runner.probe()` found (spec §7). Never contains credential values. */
export const RunnerCapabilitiesSchema = z.object({
  runner: RunnerNameSchema,
  available: z.boolean(),
  version: z.string().optional(),
  executable: z.string().optional(),
  credentials: z.enum(['ready', 'missing', 'unknown', 'not_required']),
  supports: z.object({
    jsonSchema: z.boolean(),
    resume: z.boolean(),
    quota: z.boolean(),
    effort: z.boolean(),
    readOnly: z.boolean(),
    /**
     * Can run `RunSpec.web` (research) runs (spec §17): web search/fetch without a shell, and
     * every remaining tool confined to an empty, unreadable filesystem (claude: no file tool at
     * all; codex: `apply_patch` remains, under a deny-all profile — docs/adr/0021). Unknown
     * (never probed) counts as false.
     */
    webSearch: z.boolean(),
  }),
  /** CLI flags detected as supported; runners must not pass unsupported ones. */
  flags: z.array(z.string()),
  /** Human-readable problems (missing binary, old version, …). */
  problems: z.array(z.string()),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilitiesSchema>;
