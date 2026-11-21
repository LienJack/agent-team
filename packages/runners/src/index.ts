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
