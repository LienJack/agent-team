#!/usr/bin/env node
// `team` executable (spec §12).
import { nodeIo } from './node-io.js';
import { runCli } from './program.js';

const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith('-'));
// `watch` and `ask` stop cleanly on Ctrl-C (`ask` keeps the message queued and says so);
// `serve` waits for the server (which gets the same Ctrl-C)
const longRunning = command === 'watch' || command === 'serve' || command === 'ask';

const controller = new AbortController();
process.on('SIGINT', () => {
  if (!longRunning || controller.signal.aborted) process.exit(130);
  controller.abort();
});

runCli(argv, nodeIo(controller.signal)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
