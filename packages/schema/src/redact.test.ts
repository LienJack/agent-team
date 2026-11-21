import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact.js';

describe('schema: redactSecrets', () => {
  it('masks a token inside JSON-escaped JSON (\\"token\\":\\"…\\")', () => {
    const inner = JSON.stringify({ token: 'abcdefghijklmnop1234' });
    const outer = JSON.stringify({ text: inner });
    expect(outer).toContain('\\"token\\":\\"abcdefghijklmnop1234\\"');
    const out = redactSecrets(outer);
    expect(out).not.toContain('abcdefghijklmnop1234');
    expect(out).toContain(`\\"token\\":\\"${REDACTED}\\"`);
  });

  it('masks doubly escaped assignments and keeps the surrounding JSON parseable', () => {
    const twice = JSON.stringify(
      JSON.stringify(JSON.stringify({ api_key: 'zyxwvutsrqponm98765' })),
    );
    const out = redactSecrets(twice);
    expect(out).not.toContain('zyxwvutsrqponm98765');
    expect(() => JSON.parse(JSON.parse(JSON.parse(out) as string) as string)).not.toThrow();
  });

  it('still masks plain assignments and leaves counts alone', () => {
    expect(redactSecrets('API_KEY=supersecretvalue1')).toBe(`API_KEY=${REDACTED}`);
    expect(redactSecrets('"token": "abcdefghij123"')).toBe(`"token": "${REDACTED}"`);
    expect(redactSecrets('{"input_tokens":12345678}')).toBe('{"input_tokens":12345678}');
  });
});
