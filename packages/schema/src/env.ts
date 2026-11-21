/**
 * Environment variables the system uses (spec §4 金鑰, §7, §11). `apps/server` owns the only
 * reader; it returns one requested variable at a time and never logs values.
 *
 * - `env_file`: read from the project-root `.env` (or `AGENT_TEAM_ENV_FILE`).
 * - `process`: read from the service's own process environment.
 */
export interface EnvVarSpec {
  readonly name: string;
  readonly source: 'env_file' | 'process';
  /** Secret values never reach logs, the database, API responses or other child processes. */
  readonly secret: boolean;
  readonly required: boolean;
  readonly description: string;
}

export const ENV_VARS = [
  {
    name: 'OPENROUTER_API_KEY',
    source: 'env_file',
    secret: true,
    required: false,
    description: 'dsh runner（經 OpenRouter）；只放進 dsh 子行程的環境',
  },
  {
    name: 'JEV_API_KEY',
    source: 'env_file',
    secret: true,
    required: false,
    description: 'Jev 判定關卡（預設關閉）',
  },
  {
    name: 'JEV_URL',
    source: 'env_file',
    secret: false,
    required: false,
    description: 'Jev 端點',
  },
  {
    name: 'JEV_PROVIDER',
    source: 'env_file',
    secret: false,
    required: false,
    description: 'Jev 供應者',
  },
  {
    name: 'TEAM_LAN_PASSWORD',
    source: 'env_file',
    secret: true,
    required: false,
    description: '區網看板密碼；未設定則啟動時產生一組並只在終端機印出一次',
  },
  {
    name: 'AGENT_TEAM_HOME',
    source: 'process',
    secret: false,
    required: false,
    description: '資料目錄（預設 ~/.agent-team）；測試一律覆寫到暫存目錄',
  },
  {
    name: 'AGENT_TEAM_ENV_FILE',
    source: 'process',
    secret: false,
    required: false,
    description: '改指 .env 的位置',
  },
  {
    name: 'TEAM_SMOKE',
    source: 'process',
    secret: false,
    required: false,
    description: '設為 1 才跑真實 runner 的冒煙測試',
  },
] as const satisfies readonly EnvVarSpec[];

export type EnvVarName = (typeof ENV_VARS)[number]['name'];
export type SecretEnvVarName = Extract<(typeof ENV_VARS)[number], { secret: true }>['name'];

export function envVarSpec(name: EnvVarName): EnvVarSpec {
  const spec = ENV_VARS.find((v) => v.name === name);
  if (!spec) throw new Error(`unknown env var ${name}`);
  return spec;
}

export function isSecretEnvVar(name: string): boolean {
  return ENV_VARS.some((v) => v.name === name && v.secret);
}

/** Fixed (non-secret) child environment for dsh runs (spec §7). */
export const DSH_CHILD_ENV = {
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'workspace-write',
} as const;
