// Test support for core and for the packages implementing its ports. Imports vitest (only the
// contract suite does); do not import this entry from production code.
export {
  runRepositoryContract,
  type ContractOptions,
  type StoreFactory,
} from './contract/index.js';
export {
  FakeRunner,
  implReceipt,
  reviewReceipt,
  researchReceipt,
  isResearchSpec,
  isReviewSpec,
  type FakeStep,
} from './fake-runner.js';
export { FakeGit } from './fake-git.js';
export {
  FakeCheckExecutor,
  FakeNotifier,
  FakeProcessControl,
  InMemoryRunnerRegistry,
  ManualClock,
  RecordingLeaderNotifier,
  RecordingPublisher,
  SequentialIdGen,
  type CheckScript,
} from './fakes.js';
export {
  sampleAttention,
  sampleOutbox,
  sampleProject,
  sampleRun,
  sampleTask,
  sampleWorkspace,
  testEngineConfig,
  testModelsConfig,
  testModelsInput,
} from './fixtures.js';
export { createTestEngine, editing, type TestEngine, type TestEngineOptions } from './harness.js';
