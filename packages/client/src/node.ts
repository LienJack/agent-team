// Node-only helpers (`@agent-team/client/node`): find the local listener through
// DATA/run/listener.json (spec §4). Kept out of the main entry so browser bundles never see
// `node:` imports.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_LAYOUT,
  DEFAULT_DATA_DIR,
  ListenerFileSchema,
  type ListenerFile,
} from '@agent-team/schema';
import { createTeamClient, type TeamClient, type TeamClientOptions } from './client.js';
import { TeamApiError } from './errors.js';

export interface DiscoverOptions {
  /**
   * Environment to read `AGENT_TEAM_LISTENER_FILE` / `AGENT_TEAM_HOME` from (default
   * `process.env`).
   */
  env?: Readonly<Record<string, string | undefined>>;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** `DATA`: `AGENT_TEAM_HOME` or `~/.agent-team`, with `~` expanded. */
export function resolveDataDir(env: DiscoverOptions['env'] = process.env): string {
  const fromEnv = env['AGENT_TEAM_HOME'];
  return expandHome(fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_DATA_DIR);
}

/**
 * The listener file to use: `AGENT_TEAM_LISTENER_FILE` when set (the leader's `team` points at
 * `DATA/leader/listener.json`, which holds the leader-scoped token), else
 * `DATA/run/listener.json` (the operator token).
 */
export function listenerFilePath(env: DiscoverOptions['env'] = process.env): string {
  const explicit = env['AGENT_TEAM_LISTENER_FILE'];
  if (explicit !== undefined && explicit !== '') return expandHome(explicit);
  return join(resolveDataDir(env), DATA_LAYOUT.listener);
}

const NOT_RUNNING_HINT = 'start the service with `team serve`';

/** Read and validate listener.json; `TeamApiError('unavailable')` when the server is not up. */
export async function discoverListener(options: DiscoverOptions = {}): Promise<ListenerFile> {
  const path = listenerFilePath(options.env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new TeamApiError(
      {
        code: 'unavailable',
        message: missing
          ? `agent-team is not running (no ${path})`
          : `cannot read ${path}: ${(err as Error).message}`,
        hint: NOT_RUNNING_HINT,
      },
      0,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = ListenerFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new TeamApiError(
      {
        code: 'unavailable',
        message: `${path} is not a valid listener file`,
        hint: NOT_RUNNING_HINT,
      },
      0,
    );
  }
  return parsed.data;
}

/** Discover the local listener and return a client for it (CLI, MCP). */
export async function connectLocal(
  options: DiscoverOptions & Omit<TeamClientOptions, 'baseUrl' | 'token'> = {},
): Promise<TeamClient> {
  const { env, ...clientOptions } = options;
  const listener = await discoverListener(env === undefined ? {} : { env });
  return createTeamClient({ ...clientOptions, baseUrl: listener.addr, token: listener.token });
}
