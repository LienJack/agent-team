// Ports (implemented by db, runners, git, server)
export * from './ports/index.js';
export { isWorktreeIntegrityError, WorktreeIntegrityError } from './ports/git.js';
export * from './errors.js';

// In-memory store (tests, and the reference behaviour for the SQLite store)
export { InMemoryStore } from './memory/store.js';

// Engine
export { Engine, type TickReport } from './engine/engine.js';
export { EngineContext, Tx, type EngineConfig, type EngineDeps } from './engine/context.js';
export type { Actor } from './engine/commands.js';
export type { DispatchReport } from './engine/dispatch.js';
export type { RecoveryReport } from './engine/recovery.js';
export type { RecordMessageInput } from './engine/messages.js';
export {
  resolveRole,
  type QuotaState,
  type ResolvedModel,
  type ResolveRoleOptions,
  type ResolveRoleResult,
  type UnresolvedModel,
} from './engine/resolve-role.js';
export {
  holdsPaths,
  nextRunKind,
  planDispatch,
  roleFor,
  type DeferReason,
  type Deferred,
  type PlanInput,
  type PlannedDispatch,
  type PlanResult,
} from './engine/scheduler.js';
export {
  acceptanceSection,
  buildPrompt,
  dataBlock,
  inlineText,
  formatReviewDiff,
  recoveryNoteFor,
  REVIEW_DIFF_MAX_CHARS,
  type PromptInput,
} from './engine/prompt.js';
export { formatFindings } from './engine/run-result.js';
export {
  buildResearchPrompt,
  formatResearchRefs,
  RECOMMENDATION_LABEL,
  RESEARCH_REF_RULE,
  researchText,
  type ResearchRef,
} from './engine/prompt-research.js';
export {
  checkResearchRefs,
  researchReceiptOf,
  sanitizeResearchReceipt,
} from './engine/research.js';
export { CHECK_TAIL_LINES } from './engine/verify.js';
export { EFFECT_HANDLERS, EffectExecutor } from './engine/effects.js';
export {
  effectLane,
  enqueueEffect,
  type EffectFinalizer,
  type EffectHandler,
} from './engine/effect-queue.js';
export { outboxLane } from './engine/notify.js';
export {
  circuitState,
  defaultHealth,
  readHealth,
  runnerStatuses,
  unavailability,
} from './engine/runner-health.js';
export {
  exhaustedUntil,
  quotaJitterMs,
  quotaWaitUntil,
  QUOTA_RESET_BUFFER_MS,
  QUOTA_RESET_JITTER_MAX_MS,
  QUOTA_RESET_MAX_AHEAD_MS,
} from './engine/quota-wait.js';

// Helpers
export {
  payloadHash,
  withIdempotency,
  type IdempotentOutcome,
  type IdempotentRequest,
} from './idempotency.js';
export {
  filesOutside,
  isPathOwned,
  normalizeOwnedPath,
  ownedPathsOverlap,
  type PathMatchOptions,
} from './util/paths.js';
export { canonicalJson, sha256Hex } from './util/hash.js';
export { addMs, backoffMs, lastLines } from './util/time.js';
