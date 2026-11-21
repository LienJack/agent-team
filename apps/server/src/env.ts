import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envVarSpec, ENV_VARS, type EnvVarName } from '@agent-team/schema';

// The only `.env` reader of the system (spec §4 金鑰, AGENTS.md). It returns one requested
// variable at a time, never caches the file, never logs values. The process environment wins.

export interface EnvReader {
  /** The value of one known variable (process env first, then the .env file); empty = unset. */
  get(name: EnvVarName): string | undefined;
  /** Whether `get(name)` would return a value (for doctor: names and booleans only). */
  has(name: EnvVarName): boolean;
  /** The .env path this reader uses (may not exist). */
  readonly file: string;
}

export type ProcessEnv = Readonly<Record<string, string | undefined>>;

/** `AGENT_TEAM_ENV_FILE`, else `<projectRoot>/.env`. */
export function envFilePath(projectRoot: string, processEnv: ProcessEnv): string {
  const override = processEnv['AGENT_TEAM_ENV_FILE'];
  return override !== undefined && override !== '' ? override : join(projectRoot, '.env');
}

export function isKnownEnvVar(name: string): name is EnvVarName {
  return ENV_VARS.some((v) => v.name === name);
}

/** Parse one value of a dotenv line (quotes, escapes in double quotes, inline comments). */
function parseValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      const ch = value[i]!;
      if (ch === '"') return out;
      if (ch === '\\' && i + 1 < value.length) {
        const next = value[++i]!;
        out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
        continue;
      }
      out += ch;
    }
    return out;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end < 0 ? value.slice(1) : value.slice(1, end);
  }
  const comment = value.search(/\s#/);
  return (comment < 0 ? value : value.slice(0, comment)).trim();
}

/** Scan dotenv `text` for `name` only; later assignments win (like a shell). */
export function findInDotenv(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const eq = line.indexOf('=');
    if (eq <= 0 || line.slice(0, eq).trim() !== name) continue;
    found = parseValue(line.slice(eq + 1));
  }
  return found;
}

export function createEnvReader(options: { file: string; processEnv: ProcessEnv }): EnvReader {
  const { file, processEnv } = options;
  const get = (name: EnvVarName): string | undefined => {
    const spec = envVarSpec(name); // throws for names outside ENV_VARS
    const fromProcess = processEnv[name];
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
    if (spec.source !== 'env_file') return undefined;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const value = findInDotenv(text, name);
    return value === undefined || value === '' ? undefined : value;
  };
  return { file, get, has: (name) => get(name) !== undefined };
}
