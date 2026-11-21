// Turning a project's configured check command (`checks[].cmd`, e.g. `pnpm test`) into argv
// without a shell. Quoting follows POSIX sh for the common cases: '…' is literal, "…" allows
// \" \\ \$ \`, and a backslash outside quotes escapes the next character.
//
// Commands that need shell features — operators (| & ; < > ( )), expansions ($ ` ~), globs
// (* ? [), comments (#) or leading VAR=value assignments — are run with `/bin/sh -c <cmd>`
// instead. That is deliberate: `cmd` is written by the project owner (projects can only be added
// or changed on the local listener, spec §11), it is never built from agent output, and
// operators such as `&&` are normal in check commands. The child still gets the allow-listed
// environment only, its own process group and a timeout.

export type ParsedCommand = { kind: 'argv'; argv: string[] } | { kind: 'shell'; reason: string };

const SHELL_CHARS = new Set([
  '|',
  '&',
  ';',
  '<',
  '>',
  '(',
  ')',
  '$',
  '`',
  '*',
  '?',
  '[',
  '#',
  '~',
  '\n',
]);

export function parseCommand(cmd: string): ParsedCommand {
  const argv: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1]!)) cur += cmd[++i];
      else if (ch === '$' || ch === '`') return { kind: 'shell', reason: `expansion ${ch}` };
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < cmd.length) {
        cur += cmd[++i];
        inToken = true;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) argv.push(cur);
      cur = '';
      inToken = false;
      continue;
    }
    if (SHELL_CHARS.has(ch)) return { kind: 'shell', reason: `shell syntax ${JSON.stringify(ch)}` };
    cur += ch;
    inToken = true;
  }
  if (quote) return { kind: 'shell', reason: 'unterminated quote' };
  if (inToken) argv.push(cur);
  if (argv.length === 0) return { kind: 'shell', reason: 'empty command' };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) {
    return { kind: 'shell', reason: 'leading variable assignment' };
  }
  return { kind: 'argv', argv };
}
