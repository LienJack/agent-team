// Masks key-like strings before anything reaches a log file, a RunResult message or a probe
// problem (spec §1.8, §7). Literal secret values the runner knows (e.g. the OpenRouter key it put
// into the child environment) are masked exactly; everything else by pattern.

export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // provider keys: sk-..., sk-or-v1-..., sk-ant-..., sk-proj-...
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

// `Authorization: Bearer <token>` and `API_KEY=<value>` / `"token": "<value>"` style assignments
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
// (values that are plain numbers, e.g. `"input_tokens":12345678`, are counts, not secrets)
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)((?![\d.]+(?:[\s"',;}\]]|$))[^\s"',;]{8,})/gi;

/** Mask key-like substrings and every literal in `secrets` (values shorter than 8 are ignored). */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(ASSIGNMENT, (_m, key: string) => `${key}${REDACTED}`);
  return out;
}

/** A reusable redactor bound to a set of literal secrets. */
export type Redactor = (text: string) => string;

export function makeRedactor(secrets: readonly string[] = []): Redactor {
  const literals = secrets.filter((s) => s.length >= 8);
  return (text) => redactSecrets(text, literals);
}
