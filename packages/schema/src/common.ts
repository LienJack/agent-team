import { z } from 'zod';

/** ISO 8601 UTC timestamp, always with `Z` (e.g. `2026-11-21T08:00:00.000Z`). Lexical order = time order. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: false });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** A git commit sha (abbreviated or full, lowercase hex). */
export const ShaSchema = z.string().regex(/^[0-9a-f]{4,64}$/, 'expected a lowercase hex git sha');

export const NonNegativeIntSchema = z.number().int().nonnegative();
export const PositiveIntSchema = z.number().int().positive();

/** Task tier: A = cross-module/public interfaces, B = multi-file judgement, C = interface fixed and tested. */
export const TierSchema = z.enum(['A', 'B', 'C']);
export type Tier = z.infer<typeof TierSchema>;

/** A role name from `config/models.json` `roles` (e.g. `impl_C`, `review_B`, `leader`). */
export const RoleNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]*$/);
export type RoleName = z.infer<typeof RoleNameSchema>;

/** A model alias from `config/models.json` `models` (e.g. `opus`, `gpt-sol`). */
export const ModelAliasSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

/** Reasoning effort accepted by runners; omitted when the model has no effort knob. */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

/** Runners that execute worker runs (have a `Runner` implementation). */
export const RunnerNameSchema = z.enum(['claude', 'codex', 'dsh', 'fake']);
export type RunnerName = z.infer<typeof RunnerNameSchema>;

/** Runner values allowed in `models.json`; `jev` is a judgement endpoint, not a text runner. */
export const ModelRunnerSchema = z.enum(['claude', 'codex', 'dsh', 'jev', 'fake']);
export type ModelRunner = z.infer<typeof ModelRunnerSchema>;

/** Where a human/leader input came from. */
export const MessageSourceSchema = z.enum(['web', 'cli', 'mcp', 'grok', 'service']);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

/** Arbitrary JSON value (what a JSON column can hold). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A JSON Schema document (as handed to runners for structured output). */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;
