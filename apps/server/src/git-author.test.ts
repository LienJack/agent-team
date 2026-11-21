import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createGit } from './main.js';

// service.json → git.author is the identity of service-side commits (spec §6 step 5).

const REPO_CONFIG = new URL('../../../config/', import.meta.url);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-team-git-author-'));
  // isolate git from the user's ~/.gitconfig (hooks, signing) for this test
  vi.stubEnv('HOME', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function configWith(service: object) {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  copyFileSync(new URL('models.json', REPO_CONFIG), join(configDir, 'models.json'));
  writeFileSync(join(configDir, 'service.json'), JSON.stringify(service));
  return loadConfig({ env: { AGENT_TEAM_CONFIG_DIR: configDir, AGENT_TEAM_HOME: dir } });
}

describe('git author wiring', () => {
  it('defaults to agent-team <agent-team@localhost> (also in config/service.json)', () => {
    expect(configWith({}).service.git.author).toEqual({
      name: 'agent-team',
      email: 'agent-team@localhost',
    });
    const repoDefault = loadConfig({ env: { AGENT_TEAM_HOME: dir } });
    expect(repoDefault.service.git.author).toEqual({
      name: 'agent-team',
      email: 'agent-team@localhost',
    });
  });

  it('rejects an author that would break the commit identity', () => {
    expect(() => configWith({ git: { author: { name: 'a <b>', email: 'x@y' } } })).toThrow(
      /git\.author\.name/,
    );
    expect(() => configWith({ git: { author: { email: 'no-at-sign' } } })).toThrow(
      /git\.author\.email/,
    );
  });

  it('service commits use the configured author', async () => {
    const config = configWith({
      git: { author: { name: 'Team Bot', email: 'bot@example.invalid' } },
      paths: { worktree_root: join(dir, 'wt') },
    });
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const sh = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.invalid',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
      })
        .toString('utf8')
        .trim();
    sh(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');

    const git = createGit(config);
    const worktreePath = join(config.worktreeRoot, 'demo', 't_000001');
    await git.ensureWorktree({
      repoPath: repo,
      worktreePath,
      branch: 'team/t_000001',
      baseBranch: 'main',
    });
    writeFileSync(join(worktreePath, 'a.txt'), 'b\n');
    const commit = await git.commitFiles({
      worktreePath,
      repoPath: repo,
      branch: 'team/t_000001',
      baseBranch: 'main',
      message: 'team(t_000001): x',
      files: ['a.txt'],
    });
    expect(commit.created).toBe(true);
    expect(sh(worktreePath, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
      'Team Bot <bot@example.invalid>|Team Bot <bot@example.invalid>',
    );
  });
});
