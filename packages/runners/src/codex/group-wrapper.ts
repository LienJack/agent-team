// Process-group wrapper for the Codex SDK (standalone script; node builtins only, erasable TS so
// Node runs it from src/ and dist/ alike).
//
// The SDK spawns the codex binary itself, in the service's own process group, and on abort only
// kills that one process. The runner therefore points `codexPathOverride` at a tiny shim that
// runs this script, which:
//   1. starts the real command (`AGENT_TEAM_REAL_CMD`, a JSON argv prefix) with the SDK's
//      arguments appended, in a NEW process group (detached), sharing our stdin/stdout/stderr;
//      `AGENT_TEAM_EXEC_ARGS` (JSON list, e.g. `--ignore-user-config`) is inserted right after
//      the SDK's leading `exec` subcommand, where codex accepts exec options;
//   2. writes that group id to `AGENT_TEAM_PGID_FILE` so the runner can kill the group itself;
//   3. on SIGTERM/SIGINT/SIGHUP (the SDK's abort) terminates the whole group: SIGTERM, then
//      SIGKILL after the grace period;
//   4. exits with the child's status, after signalling any survivors of the group.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { constants } from 'node:os';

const GRACE_MS = Number(process.env.AGENT_TEAM_KILL_GRACE_MS ?? '5000');

function main(): void {
  let cmd: unknown;
  try {
    cmd = JSON.parse(process.env.AGENT_TEAM_REAL_CMD ?? '[]');
  } catch {
    cmd = [];
  }
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === 'string')) {
    process.stderr.write('agent-team codex wrapper: AGENT_TEAM_REAL_CMD is missing\n');
    process.exit(127);
  }
  const argv = cmd as string[];
  const pgidFile = process.env.AGENT_TEAM_PGID_FILE;
  let extra: unknown;
  try {
    extra = JSON.parse(process.env.AGENT_TEAM_EXEC_ARGS ?? '[]');
  } catch {
    extra = [];
  }
  const execArgs = Array.isArray(extra) ? extra.filter((a) => typeof a === 'string') : [];
  const sdkArgs = process.argv.slice(2);
  const args =
    sdkArgs[0] === 'exec' && execArgs.length > 0
      ? ['exec', ...execArgs, ...sdkArgs.slice(1)]
      : sdkArgs;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('AGENT_TEAM_')) env[k] = v;
  }

  const child = spawn(argv[0]!, [...argv.slice(1), ...args], {
    stdio: 'inherit',
    detached: true,
    env,
  });

  const signalGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // group already gone
    }
  };

  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalGroup('SIGTERM');
    setTimeout(() => {
      signalGroup('SIGKILL');
      process.exit(143);
    }, GRACE_MS).unref();
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, terminate);

  child.once('spawn', () => {
    if (pgidFile && child.pid !== undefined) {
      try {
        writeFileSync(pgidFile, `${child.pid}\n`, { mode: 0o600 });
      } catch {
        // the runner falls back to the SDK's own kill
      }
    }
  });
  child.once('error', (err) => {
    process.stderr.write(`agent-team codex wrapper: cannot start ${argv[0]}: ${err.message}\n`);
    process.exit(127);
  });
  child.once('exit', (code, signal) => {
    signalGroup('SIGTERM');
    const signo = signal ? (constants.signals[signal] ?? 1) : 0;
    process.exit(code ?? 128 + signo);
  });
}

main();
