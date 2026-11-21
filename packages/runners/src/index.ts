// Runner implementations (spec §7): claude, codex, dsh, the in-process fake; the shared
// child-process utilities; and the CheckExecutor (spec §6 step 4).
export { createRunnerRegistry } from './registry.js';
export { createCheckExecutor } from './checks/executor.js';
export type {
  EnvReader,
  FakeRunStep,
  ManagedRunnerRegistry,
  RunnerRegistryOptions,
  ScriptableFakeRunner,
} from './types.js';
export { redactSecrets } from './redact.js';

// Shared pieces for the server's own headless processes (leader conversation, Grok bridge):
// argv-only spawning in a process group, allow-listed child environments, probes, and one
// plain-text `claude -p` call.
export { childEnv, findExecutable } from './process/env.js';
export { runChild, type ChildResult, type ChildSpec } from './process/spawn.js';
export { capture, parseHelpFlags, type Captured } from './process/capture.js';
export { assertNoPermissionBypass, PERMISSION_BYPASS_FLAGS } from './claude/args.js';
export {
  probeClaudeCli,
  runClaudeText,
  type ClaudeProbe,
  type ClaudeTextInput,
  type ClaudeTextResult,
} from './claude/text.js';
