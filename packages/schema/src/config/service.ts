import { z } from 'zod';
import { MEMORY_CUBE_PREFIX_RE } from '../memory.js';

/** 0 = let the OS pick a free port (tests, ephemeral instances). */
const port = z.number().int().min(0).max(65535);
const ms = z.number().int().positive();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a local time like "23:00"');

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
      /** Routine notifications of the same kind within this window go out as one message. */
      coalesce_window_ms: ms.default(60000),
      /**
       * Local "HH:MM" times; routine notifications wait until `end`. Attention items and quota
       * notices are never delayed. null = no quiet hours.
       */
      quiet_hours: z.strictObject({ start: hhmm, end: hhmm }).nullable().default(null),
      /** Texts longer than this are condensed by role `hub_summarizer` before they are sent. */
      summarize_threshold_chars: z.number().int().positive().default(600),
      /** Hard length cap of a condensed (or truncated) text. */
      summary_max_chars: z.number().int().positive().default(500),
      /**
       * Option buttons (spec §10, docs/adr/0022): attached only when the question and every
       * option fit these limits whole. grokmsg pushes at most 6000 characters of text and echoes
       * at most 300 characters of a question with a pick; it documents no label limit, so the
       * label and count limits are conservative assumptions.
       */
      buttons: z
        .strictObject({
          message_max_chars: z.number().int().positive().default(6000),
          question_max_chars: z.number().int().positive().default(300),
          option_max_chars: z.number().int().positive().default(40),
          max_options: z.number().int().positive().default(5),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Machine checks (spec §6 step 4; docs/adr/0019). */
  checks: z
    .strictObject({
      /**
       * Run checks without a sandbox where `sandbox-exec` is missing (Linux until bubblewrap
       * support exists). Default false: such a check is not run and the task is blocked.
       */
      allow_unsandboxed: z.boolean().default(false),
    })
    .prefault({}),
  /** Worker runner settings (docs/adr/0019). */
  runners: z
    .strictObject({
      dsh: z
        .strictObject({
          /** Run dsh without Seatbelt where it is missing. Default false: dsh is unavailable. */
          allow_unsandboxed: z.boolean().default(false),
        })
        .prefault({}),
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
  /** Research stage (spec §17; docs/adr/0021). */
  research: z
    .strictObject({
      /**
       * `off`: research entrances answer 409; `on_request` (default): research runs only when a
       * person asks for it; `auto`: the leader researches first when a task introduces a new
       * subsystem, library choice, protocol or algorithm design (not for small changes).
       */
      mode: z.enum(['off', 'on_request', 'auto']).default('on_request'),
      /** One research run is stopped after this long (default 10 minutes). */
      timeout_ms: ms.default(600000),
    })
    .prefault({}),
  /**
   * Project memory in an existing MemOS server (spec §18; docs/adr/0023). Off by default; while
   * off nothing ever contacts `base_url`.
   */
  memory: z
    .strictObject({
      enabled: z.boolean().default(false),
      /**
       * MemOS REST root (no path, no credentials, an explicit port): its API is under `/product`.
       * The port is required because the sandboxes refuse it on every host (docs/adr/0023): an
       * implied 80/443 would cut workers and checks off the web.
       */
      base_url: z
        .string()
        .regex(
          /^https?:\/\/[A-Za-z0-9.-]+:\d{1,5}\/?$/,
          'a URL with a port, like "http://host:8000"',
        )
        .default('http://greennas.local:8000'),
      /** Fixed `user_id` of every request (MemOS has no authentication). */
      user_id: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,64}$/)
        .default('agent-team'),
      /**
       * Cube id prefix: a project's cube is `<cube_prefix><project_id>`; the service never reads
       * or writes a cube without it. Lowercase, ending in `-`, at least 4 characters.
       */
      cube_prefix: z
        .string()
        .regex(MEMORY_CUBE_PREFIX_RE, 'lowercase letters, digits and dashes, ending in "-"')
        .default('agent-team-'),
      /** Items per search (MemOS `top_k`). */
      top_k: z.number().int().min(1).max(20).default(6),
      /** Minimum relevance of a search hit (MemOS `relativity`). */
      relativity: z.number().min(0).max(1).default(0.45),
      /** One read (search before a dispatch, list, delete); a timeout means "unavailable". */
      timeout_ms: ms.max(60000).default(6000),
      /** Cap of one written item (MemOS stores longer content without a vector: issue #2461). */
      max_item_chars: z.number().int().min(100).max(8000).default(1200),
      /** Cap of the 專案記憶 block in a worker prompt. */
      max_prompt_chars: z.number().int().min(100).max(20000).default(1500),
      /**
       * How MemOS ingests a write: `sync_fast` (the default) stores the text as given with an
       * embedding only, no chat model; `async` answers at once and lets the MemOS scheduler
       * re-extract the item with its chat model, replacing it (new id, paraphrase, `team_*`
       * metadata dropped). Live-verified: docs/adr/0023.
       */
      add_mode: z.enum(['async', 'sync_fast']).default('sync_fast'),
      /** Switch individual write sources off. */
      write_sources: z
        .strictObject({
          task: z.boolean().default(true),
          decision: z.boolean().default(true),
          human: z.boolean().default(true),
          research: z.boolean().default(true),
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
      /** Retries the leader may request per task until a human retries it (docs/adr/0014). */
      leader_retry_budget: z.number().int().nonnegative().default(2),
      retry_initial_ms: ms.default(5000),
      retry_max_ms: ms.default(300000),
      /** Cooldown after a rate limit without `resetsAt` (spec §8: 15 minutes). */
      rate_limit_cooldown_ms: ms.default(900000),
      /**
       * Cooldowns in a row whose first following run hit the rate limit again before the runner
       * stops resuming by itself (open circuit + attention item until a person re-arms it;
       * docs/adr/0022).
       */
      rate_limit_loop_limit: z.number().int().positive().default(3),
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
      /**
       * Run the headless leader conversation (spec §9). Independent of the worker runners:
       * `AGENT_TEAM_FAKE_RUNNERS=1` with the real leader is the cheapest realistic setup.
       * false = messages are stored, never answered.
       */
      enabled: z.boolean().default(true),
      /** Send `/compact` above this many context tokens (spec §9). */
      compact_threshold_tokens: z.number().int().positive().default(60000),
      /**
       * Quiet window of the leader's event digest: it is due once no relevant event arrived for
       * this long, so tasks finishing a few seconds apart become one turn (validation
       * 2026-11-21: 3 s gave three digests for three tasks).
       */
      event_window_ms: ms.default(15000),
      /** A digest is never later than this after its oldest event. */
      event_max_wait_ms: ms.default(60000),
      /** Events per digest turn (more wait for the next one; a full batch is due at once). */
      digest_max_events: z.number().int().positive().default(30),
      /** One leader turn (one `claude -p` process) is killed after this long. */
      turn_timeout_ms: ms.default(600000),
      /**
       * POST /leader/messages with `wait: true` answers `pending: true` after this long. Stays
       * below the 300 s header timeout of Node's fetch (undici), so a long turn never looks like
       * a dropped connection; the caller then polls GET /leader/messages/:id.
       */
      reply_wait_ms: ms.max(290000).default(240000),
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
export type ResearchSettings = ServiceConfig['research'];
export type ResearchMode = ResearchSettings['mode'];
export type MemorySettings = ServiceConfig['memory'];

export function parseServiceConfig(json: unknown): ServiceConfig {
  return ServiceConfigSchema.parse(json);
}

/** Fully defaulted service config. */
export function defaultServiceConfig(): ServiceConfig {
  return ServiceConfigSchema.parse({});
}
