import { describe, expect, it } from 'vitest';
import { TaskListQuerySchema, TaskCreateRequestSchema } from './api/dto.js';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  errorEnvelope,
  ErrorEnvelopeSchema,
  exitCodeFor,
} from './api/errors.js';
import { ENV_VARS, isSecretEnvVar } from './env.js';
import { EVENT_TYPES, EventRecordSchema, parseEventData } from './events.js';
import { ID_PREFIXES, isIdOf, newId, TaskIdSchema } from './ids.js';
import { commitMessage, joinPosix, runLogDir, taskBranch, taskWorktreePath } from './paths.js';

describe('ids', () => {
  it('have the kind prefix and a random base32 part', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id.startsWith(ID_PREFIXES[kind])).toBe(true);
      expect(isIdOf(kind, id)).toBe(true);
    }
    const many = new Set(Array.from({ length: 500 }, () => newId('task')));
    expect(many.size).toBe(500);
    expect(TaskIdSchema.safeParse('p_abc').success).toBe(false);
  });
});

describe('events', () => {
  it('parse a stored event and reject mismatched data', () => {
    const ok = {
      seq: 1,
      ts: '2026-11-21T00:00:00.000Z',
      task_id: 't_1',
      run_id: null,
      type: 'task.status_changed',
      data: { from: 'queued', to: 'running', reason: null },
    };
    expect(EventRecordSchema.parse(ok)).toEqual(ok);
    expect(EventRecordSchema.safeParse({ ...ok, data: { from: 'queued' } }).success).toBe(false);
    expect(EventRecordSchema.safeParse({ ...ok, type: 'nope' }).success).toBe(false);
    expect(() => parseEventData('runner.circuit_closed', { runner: 'claude' })).not.toThrow();
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});

describe('api contracts', () => {
  it('error envelope has a status for every code', () => {
    for (const code of ERROR_CODES) expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(ERROR_HTTP_STATUS.not_implemented).toBe(501);
    expect(exitCodeFor('not_implemented')).toBe(1);
    const env = errorEnvelope('not_found', 'no such task', 'team task list');
    expect(ErrorEnvelopeSchema.parse(env)).toEqual(env);
    expect(errorEnvelope('internal', 'x')).toEqual({ error: { code: 'internal', message: 'x' } });
  });

  it('task list query splits statuses', () => {
    expect(TaskListQuerySchema.parse({ status: 'queued,running' })).toEqual({
      status: ['queued', 'running'],
    });
    expect(TaskListQuerySchema.safeParse({ status: 'queued,bogus' }).success).toBe(false);
  });

  it('task create defaults priority and queue', () => {
    const req = TaskCreateRequestSchema.parse({
      project_id: 'p_1',
      title: 't',
      tier: 'C',
      ticket_md: '#',
      owned_paths: ['src/'],
    });
    expect(req).toMatchObject({ priority: 0, queue: false });
    expect(
      TaskCreateRequestSchema.safeParse({ ...req, owned_paths: ['../etc/passwd'] }).success,
    ).toBe(false);
  });
});

describe('env and paths', () => {
  it('list the secrets from .env.example', () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['OPENROUTER_API_KEY', 'JEV_API_KEY']));
    // the LAN board has no password any more (docs/adr/0024)
    expect(names).not.toContain('TEAM_LAN_PASSWORD');
    expect(isSecretEnvVar('OPENROUTER_API_KEY')).toBe(true);
    expect(isSecretEnvVar('AGENT_TEAM_HOME')).toBe(false);
  });

  it('list every process variable the apps read', () => {
    const process = ENV_VARS.filter((v) => v.source === 'process').map((v) => v.name);
    expect(process).toEqual(
      expect.arrayContaining([
        'AGENT_TEAM_HOME',
        'AGENT_TEAM_ENV_FILE',
        'AGENT_TEAM_CONFIG_DIR',
        'AGENT_TEAM_FAKE_RUNNERS',
        'AGENT_TEAM_LISTENER_FILE',
        'AGENT_TEAM_SERVER_ENTRY',
      ]),
    );
    for (const name of process) expect(isSecretEnvVar(name)).toBe(false);
  });

  it('build the spec layout', () => {
    expect(joinPosix('/a/', '/b', 'c/')).toBe('/a/b/c');
    expect(runLogDir('/data', 'r_1')).toBe('/data/runs/r_1');
    expect(taskBranch('t_1')).toBe('team/t_1');
    expect(taskWorktreePath('/w', 'proj', 't_1')).toBe('/w/proj/t_1');
    expect(commitMessage('t_1', '加功能')).toBe('team(t_1): 加功能');
  });
});
