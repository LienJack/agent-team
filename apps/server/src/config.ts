import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DATA_DIR,
  ModelsConfigSchema,
  ServiceConfigSchema,
  type ModelsConfig,
  type ServiceConfig,
} from '@agent-team/schema';
import type { ProcessEnv } from './env.js';

/** Everything the service needs from config files and paths (spec §4). */
export interface LoadedConfig {
  service: ServiceConfig;
  models: ModelsConfig;
  /** Repository root (holds `.env`, `config/`, `apps/web/dist`). */
  projectRoot: string;
  configDir: string;
  /** Absolute `DATA` directory. */
  dataDir: string;
  /** Absolute worktree root (`~` expanded). */
  worktreeRoot: string;
  /** `apps/web/dist` when it holds a built board (`index.html`), else undefined. */
  webDist: string | undefined;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** The workspace root above `from` (nearest pnpm-workspace.yaml). */
export function findProjectRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new ConfigError(`cannot find the project root above ${from}`);
    dir = parent;
  }
}

/** `AGENT_TEAM_HOME` or `~/.agent-team`, absolute. */
export function resolveDataDir(env: ProcessEnv): string {
  const fromEnv = env['AGENT_TEAM_HOME'];
  return resolve(expandHome(fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_DATA_DIR));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function describeIssues(
  path: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
) {
  const lines = issues
    .slice(0, 10)
    .map((i) => `  ${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
  return `${path} is invalid:\n${lines.join('\n')}`;
}

export interface LoadConfigOptions {
  env: ProcessEnv;
  /** Defaults to the workspace root above this module. */
  projectRoot?: string;
}

/**
 * Read and validate `config/service.json` (optional: all defaults) and `config/models.json`
 * (required). `AGENT_TEAM_CONFIG_DIR` points at another config directory (tests, other setups).
 */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const projectRoot =
    options.projectRoot ?? findProjectRoot(dirname(fileURLToPath(import.meta.url)));
  const override = options.env['AGENT_TEAM_CONFIG_DIR'];
  const configDir =
    override !== undefined && override !== '' ? resolve(override) : join(projectRoot, 'config');

  const servicePath = join(configDir, 'service.json');
  const serviceRaw = existsSync(servicePath) ? readJson(servicePath) : {};
  const service = ServiceConfigSchema.safeParse(serviceRaw);
  if (!service.success) throw new ConfigError(describeIssues(servicePath, service.error.issues));

  const modelsPath = join(configDir, 'models.json');
  if (!existsSync(modelsPath)) throw new ConfigError(`${modelsPath} is missing`);
  const models = ModelsConfigSchema.safeParse(readJson(modelsPath));
  if (!models.success) throw new ConfigError(describeIssues(modelsPath, models.error.issues));

  const worktree = expandHome(service.data.paths.worktree_root);
  const webDist = join(projectRoot, 'apps', 'web', 'dist');
  return {
    service: service.data,
    models: models.data,
    projectRoot,
    configDir,
    dataDir: resolveDataDir(options.env),
    worktreeRoot: isAbsolute(worktree) ? worktree : resolve(projectRoot, worktree),
    webDist: existsSync(join(webDist, 'index.html')) ? webDist : undefined,
  };
}
