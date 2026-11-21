import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// Child environments are built from an allow-list, never inherited wholesale: the service's own
// environment may hold secrets, git overrides (GIT_DIR, GIT_WORK_TREE, …) or the variables of an
// enclosing agent session (CLAUDECODE, ANTHROPIC_BASE_URL, …) that must not leak into a worker.

/** Variables every child gets when the service has them (no credentials). */
export const BASE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  '__CF_USER_TEXT_ENCODING',
] as const;

const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** Proxy variables whose values are URLs that may carry `user:password@`. */
const PROXY_NAMES = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]);

/**
 * A proxy URL (or `host:port`) without its userinfo: `http://user:pw@proxy:8080` →
 * `http://proxy:8080`. The rest of the value is kept as written. Undefined when it does not
 * parse as a URL with a host (the variable is then not passed at all).
 */
export function stripProxyUserinfo(value: string): string | undefined {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  try {
    if (new URL(hasScheme ? value : `http://${value}`).host === '') return undefined;
  } catch {
    return undefined;
  }
  const m = /^((?:[a-z][a-z0-9+.-]*:\/\/)?)([^/?#]*)([\s\S]*)$/i.exec(value);
  if (!m) return undefined;
  const authority = m[2] ?? '';
  const at = authority.lastIndexOf('@');
  return at < 0 ? value : `${m[1] ?? ''}${authority.slice(at + 1)}${m[3] ?? ''}`;
}

/**
 * The allow-listed environment plus `extraNames` (non-secret, runner-specific, e.g.
 * `CLAUDE_CONFIG_DIR`), then `overrides` on top. `NO_COLOR=1` keeps output parseable. Proxy
 * variables lose any embedded credentials (`stripProxyUserinfo`).
 */
export function childEnv(
  extraNames: readonly string[] = [],
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV_NAMES, ...extraNames]) {
    const raw = source[name];
    const value = raw !== undefined && PROXY_NAMES.has(name) ? stripProxyUserinfo(raw) : raw;
    if (value !== undefined && value !== '') env[name] = value;
  }
  env.PATH ??= FALLBACK_PATH;
  env.NO_COLOR = '1';
  return { ...env, ...overrides };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `name` on `PATH` (no shell, no `which`); absolute paths are checked as-is. */
export function findExecutable(
  name: string,
  pathValue = process.env.PATH ?? FALLBACK_PATH,
): string | undefined {
  if (isAbsolute(name) || name.includes('/')) return isExecutableFile(name) ? name : undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}
