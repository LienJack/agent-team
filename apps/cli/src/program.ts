import { TeamApiError, type TeamClient } from '@agent-team/client';
import { EXIT_CODES, exitCodeFor } from '@agent-team/schema';
import { Command, CommanderError } from 'commander';
import { registerGateCommand } from './commands/gate.js';
import { registerMemoryCommands } from './commands/memory.js';
import { registerResearchCommands } from './commands/research.js';
import { registerSystemCommands } from './commands/system.js';
import { registerTalkCommands } from './commands/talk.js';
import { registerWorkCommands } from './commands/work.js';
import { UsageError, type CliIo } from './io.js';

/** What every command gets: IO, the (lazily connected) client and the output helper. */
export interface CommandContext {
  io: CliIo;
  client(): Promise<TeamClient>;
  /** `--json` → `data` as JSON; otherwise the short text. */
  print(data: unknown, text: string | (() => string)): void;
  json(): boolean;
  /** Exit code to return when the action finishes without throwing (default 0). */
  exitCode: number;
}

/** Build the `team` program (spec §12) over `ctx`. */
export function buildProgram(ctx: CommandContext): Command {
  const program = new Command('team')
    .description('agent-team: talk to the local agent-team service')
    .option('--json', 'machine-readable JSON output')
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (text) => ctx.io.stdout(text),
      writeErr: (text) => ctx.io.stderr(text),
    });
  registerSystemCommands(program, ctx);
  registerWorkCommands(program, ctx);
  registerResearchCommands(program, ctx);
  registerMemoryCommands(program, ctx);
  registerGateCommand(program, ctx);
  registerTalkCommands(program, ctx);
  return program;
}

function printError(ctx: CommandContext, err: TeamApiError): void {
  if (ctx.json()) {
    ctx.io.stdout(`${JSON.stringify({ error: err.toJSON() })}\n`);
    return;
  }
  ctx.io.stderr(`error: ${err.message}\n`);
  if (err.hint) ctx.io.stderr(`hint: ${err.hint}\n`);
}

/**
 * Run `team <argv>`; resolves with the exit code (spec §12: 0 ok, 1 business error, 2 usage or
 * connection error). Never calls process.exit.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let client: Promise<TeamClient> | undefined;
  let json = argv.includes('--json');
  const ctx: CommandContext = {
    io,
    client: () => (client ??= io.connect()),
    json: () => json,
    print: (data, text) => {
      if (json) io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      else io.stdout(`${typeof text === 'function' ? text() : text}\n`);
    },
    exitCode: EXIT_CODES.ok,
  };
  const program = buildProgram(ctx);
  program.hook('preAction', (_this, action) => {
    json = Boolean(action.optsWithGlobals()['json']);
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return ctx.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // help and version end here with exit code 0; parse errors were already printed
      return err.exitCode === 0 ? EXIT_CODES.ok : EXIT_CODES.usage;
    }
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n`);
      return EXIT_CODES.usage;
    }
    if (err instanceof TeamApiError) {
      printError(ctx, err);
      return exitCodeFor(err.code);
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CODES.business;
  }
}
