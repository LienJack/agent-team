import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HOME_DENY } from '@agent-team/runners';
import { DATA_LAYOUT } from '@agent-team/schema';

// The leader's Bash commands run in Claude Code's sandbox (docs/adr/0012), the same mechanism as
// the claude workers (`--settings` with `sandbox`), but scoped to what the `team` shim needs:
// - reads: home and DATA are closed; re-opened are the shim (`DATA/leader/bin`), the empty cwd,
//   the leader's own listener file and turn key, the socket, and the built CLI (`apps`,
//   `packages`, `node_modules`, `package.json` of this checkout — not its `.env`); the credential
//   directories under home and the service `.env` stay denied;
// - writes: nowhere in DATA or the deny list (Claude Code allows its temp dir);
// - network: no domains at all (strict, empty allowlist), no loopback (`allowLocalBinding:
//   false`), and exactly one unix socket — `DATA/leader/api.sock`, the local listener's app for
//   the leader token. Claude Code's generator renders that as `network-outbound (remote
//   unix-socket (subpath …))`, the only way to scope it: `allowLocalBinding` would open every
//   loopback port.
// `autoAllowBashIfSandboxed: false` keeps the allow/deny lists of args.ts in force.

export interface LeaderSandboxInput {
  dataDir: string;
  /** The `team` CLI entry (`<checkout>/apps/cli/dist/bin.js`). */
  teamEntry: string;
  /** Node executable the shim runs (re-opened when it lives under home). */
  nodePath: string;
  /** Service-wide deny list (DATA, the service `.env`, this checkout's `.env`). */
  denyPaths: readonly string[];
  home?: string;
}

const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export function leaderSocketPath(dataDir: string): string {
  return join(dataDir, DATA_LAYOUT.leaderSocket);
}

/** The `--settings` object of every leader turn. */
export function leaderSandboxSettings(input: LeaderSandboxInput): Record<string, unknown> {
  const home = strip(input.home ?? homedir());
  const data = strip(input.dataDir);
  const checkout = resolve(input.teamEntry, '..', '..', '..', '..');
  const socket = leaderSocketPath(data);
  const deny = [
    ...new Set(
      [
        data,
        ...input.denyPaths,
        ...HOME_DENY.map((p) => join(home, p)),
        join(checkout, '.env'),
      ].map(strip),
    ),
  ];
  const nodeRoot = dirname(dirname(input.nodePath));
  const allowRead = [
    join(data, 'leader', 'bin'),
    join(data, 'leader', 'cwd'),
    join(data, DATA_LAYOUT.leaderListener),
    join(data, DATA_LAYOUT.leaderTurnKey),
    socket,
    join(checkout, 'apps'),
    join(checkout, 'packages'),
    join(checkout, 'node_modules'),
    join(checkout, 'package.json'),
    ...(nodeRoot.startsWith(`${home}/`) ? [nodeRoot] : []),
  ];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      filesystem: { denyRead: [...deny, home], allowRead, denyWrite: deny },
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
        allowUnixSockets: [socket],
      },
    },
  };
}
