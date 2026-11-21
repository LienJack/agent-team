// `team` CLI (spec §12): a thin wrapper over @agent-team/client. The executable is `src/bin.ts`
// (`dist/bin.js`); everything here is importable for tests and other wrappers.
export { buildProgram, runCli, type CommandContext } from './program.js';
export { UsageError, type CliIo } from './io.js';
export { nodeIo, runServer, serverEntry } from './node-io.js';
export * from './format.js';
export { parseCheck, parsePaths } from './commands/work.js';
export { parseSeq } from './commands/system.js';
