import { describe, expect, it } from 'vitest';
import { childEnv, stripProxyUserinfo } from './env.js';

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
