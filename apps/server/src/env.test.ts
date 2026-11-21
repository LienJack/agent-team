import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveDataDir } from './config.js';
import { createEnvReader, envFilePath, findInDotenv, secretsInProcessEnv } from './env.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-env-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('env reader (spec §4: one variable at a time, process env wins)', () => {
  it('reads one variable from the file; quotes, export, comments; empty = unset', () => {
    const file = join(dir, '.env');
    writeFileSync(
      file,
      [
        '# comment',
        'export OPENROUTER_API_KEY="sk-or-\\"quoted\\""',
        "JEV_URL='http://jev.local/#x'",
        'JEV_PROVIDER=acme # trailing comment',
        'TEAM_LAN_PASSWORD=',
        'JEV_API_KEY=first',
        'JEV_API_KEY=second',
      ].join('\n'),
    );
    const env = createEnvReader({ file, processEnv: {} });
    expect(env.get('OPENROUTER_API_KEY')).toBe('sk-or-"quoted"');
    expect(env.get('JEV_URL')).toBe('http://jev.local/#x');
    expect(env.get('JEV_PROVIDER')).toBe('acme');
    expect(env.get('TEAM_LAN_PASSWORD')).toBeUndefined();
    expect(env.has('TEAM_LAN_PASSWORD')).toBe(false);
    expect(env.get('JEV_API_KEY')).toBe('second');
  });

  it('the process environment wins; process-only variables never come from the file', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'JEV_URL=from-file\nAGENT_TEAM_HOME=/from/file\n');
    const env = createEnvReader({ file, processEnv: { JEV_URL: 'from-process' } });
    expect(env.get('JEV_URL')).toBe('from-process');
    expect(env.get('AGENT_TEAM_HOME')).toBeUndefined();
  });

  it('a missing file means unset; unknown names throw', () => {
    const env = createEnvReader({ file: join(dir, 'missing.env'), processEnv: {} });
    expect(env.get('OPENROUTER_API_KEY')).toBeUndefined();
    expect(() => env.get('PATH' as never)).toThrow(/unknown env var/);
  });

  it('names the secrets set in the process environment, never their values (docs/adr/0020)', () => {
    const names = secretsInProcessEnv({
      OPENROUTER_API_KEY: 'sk-or-v1-from-process-env-0000',
      TEAM_LAN_PASSWORD: 'pw-from-process',
      JEV_API_KEY: '',
      JEV_URL: 'http://jev.local',
      AGENT_TEAM_HOME: '/tmp/x',
    });
    expect(names).toEqual(['OPENROUTER_API_KEY', 'TEAM_LAN_PASSWORD']);
    expect(secretsInProcessEnv({})).toEqual([]);
    // every secret the service uses is covered
    expect(
      secretsInProcessEnv({ OPENROUTER_API_KEY: 'x', JEV_API_KEY: 'x', TEAM_LAN_PASSWORD: 'x' }),
    ).toEqual(['OPENROUTER_API_KEY', 'JEV_API_KEY', 'TEAM_LAN_PASSWORD']);
  });

  it('AGENT_TEAM_ENV_FILE overrides the project-root .env', () => {
    expect(envFilePath('/repo', {})).toBe('/repo/.env');
    expect(envFilePath('/repo', { AGENT_TEAM_ENV_FILE: '/elsewhere/.env' })).toBe(
      '/elsewhere/.env',
    );
  });

  it('findInDotenv only extracts the requested name', () => {
    expect(findInDotenv('A=1\nAB=2\n B = 3 \n', 'B')).toBe('3');
    expect(findInDotenv('A=1\n', 'B')).toBeUndefined();
  });
});

describe('config loading', () => {
  const models = {
    models: { m: { runner: 'fake', model: 'fake-1' } },
    roles: Object.fromEntries(
      ['impl_A', 'impl_B', 'impl_C', 'review_A', 'review_B', 'review_C'].map((r) => [
        r,
        { use: 'm', slots: 1 },
      ]),
    ),
    rules: {
      max_fix_rounds_before_escalate: 2,
      reviewer_must_differ_from_implementer: false,
      machine_checks_before_model_review: true,
      quota: { claude_high_utilization: 0.7 },
    },
  };

  it('validates both files, defaults service.json, resolves DATA and the worktree root', () => {
    const configDir = join(dir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'models.json'), JSON.stringify(models));
    const cfg = loadConfig({
      env: { AGENT_TEAM_CONFIG_DIR: configDir, AGENT_TEAM_HOME: join(dir, 'data') },
      projectRoot: dir,
    });
    expect(cfg.service.local).toEqual({ host: '127.0.0.1', port: 4517 });
    expect(cfg.dataDir).toBe(join(dir, 'data'));
    expect(cfg.worktreeRoot).toBe(join(homedir(), 'RanoLabs', 'worktrees'));
    expect(cfg.webDist).toBeUndefined();
  });

  it('reports invalid files as ConfigError with the failing path', () => {
    const configDir = join(dir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'models.json'), JSON.stringify(models));
    writeFileSync(join(configDir, 'service.json'), JSON.stringify({ local: { port: 'x' } }));
    const load = () => loadConfig({ env: { AGENT_TEAM_CONFIG_DIR: configDir }, projectRoot: dir });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/local\.port/);
    rmSync(join(configDir, 'models.json'));
    writeFileSync(join(configDir, 'service.json'), '{}');
    expect(load).toThrow(/models\.json is missing/);
  });

  it('the data directory defaults to ~/.agent-team', () => {
    expect(resolveDataDir({})).toBe(join(homedir(), '.agent-team'));
    expect(resolveDataDir({ AGENT_TEAM_HOME: '~/x' })).toBe(join(homedir(), 'x'));
  });
});
