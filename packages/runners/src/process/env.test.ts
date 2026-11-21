import { describe, expect, it } from 'vitest';
import { BASE_ENV_NAMES, childEnv, stripProxyUserinfo } from './env.js';

// Proxy variables are passed to children (a corporate proxy may be needed to reach the model
// API), but credentials embedded in them (`http://user:pass@proxy:8080`) are not: a worker could
// print its environment, and the value is a secret of the person's network account.

describe('runners: proxy variables without credentials', () => {
  it('drops userinfo from every proxy variable, both cases', () => {
    const env = childEnv(
      [],
      {},
      {
        PATH: '/usr/bin',
        HTTP_PROXY: 'http://alice:s3cret@proxy.example:8080',
        https_proxy: 'http://bob@proxy.example:3128/',
        ALL_PROXY: 'socks5://u:p@socks.example:1080',
        all_proxy: 'socks5h://socks.example:1080',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    );
    expect(env.HTTP_PROXY).toBe('http://proxy.example:8080');
    expect(env.https_proxy).toBe('http://proxy.example:3128/');
    expect(env.ALL_PROXY).toBe('socks5://socks.example:1080');
    expect(env.all_proxy).toBe('socks5h://socks.example:1080');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(JSON.stringify(env)).not.toMatch(/s3cret|alice|bob|u:p@/);
  });

  it('keeps host:port values and drops values it cannot parse', () => {
    expect(stripProxyUserinfo('proxy.example:8080')).toBe('proxy.example:8080');
    expect(stripProxyUserinfo('user:pw@proxy.example:8080')).toBe('proxy.example:8080');
    expect(stripProxyUserinfo('http://[::1]:3128')).toBe('http://[::1]:3128');
    expect(stripProxyUserinfo('http://%zz@:x')).toBeUndefined();
    const env = childEnv([], {}, { PATH: '/usr/bin', HTTPS_PROXY: 'http://a b@::' });
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});

describe('runners: no child gets a credential through its environment (docs/adr/0020 audit)', () => {
  // the extra names each child adds to BASE_ENV_NAMES (claude/runner.ts, codex/runner.ts,
  // dsh/runner.ts, the server's leader/process.ts and hub/grokmsg.ts): paths, never secrets
  const EXTRA = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'GROKMSG_HOME', 'GROKMSG_ENV_FILE'];
  const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SOCK/i;

  it('the allow-list names no credential or agent socket', () => {
    for (const name of [...BASE_ENV_NAMES, ...EXTRA]) expect(name).not.toMatch(SECRET_NAME);
  });

  it("the service's secrets and the user's credentials never pass", () => {
    const hostile = {
      PATH: '/usr/bin',
      OPENROUTER_API_KEY: 'sk-or-v1-not-real-000000000000',
      JEV_API_KEY: 'jev-not-real-0000',
      TEAM_LAN_PASSWORD: 'lan-not-real-0000',
      ANTHROPIC_API_KEY: 'sk-ant-not-real-0000',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-not-real-0000',
      OPENAI_API_KEY: 'sk-proj-not-real-0000',
      GITHUB_TOKEN: 'ghp_notreal000000000000000000',
      AWS_SECRET_ACCESS_KEY: 'aws-not-real-0000',
      SSH_AUTH_SOCK: '/private/var/run/com.apple.launchd.x/Listeners',
      AGENT_TEAM_LISTENER_FILE: '/data/run/listener.json',
    };
    const env = childEnv(EXTRA, {}, hostile);
    expect(Object.keys(env).sort()).toEqual(['NO_COLOR', 'PATH']);
  });
});
