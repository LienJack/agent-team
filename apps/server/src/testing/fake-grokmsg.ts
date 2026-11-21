// Test support: a fake `grokmsg` executable (never the real one) in a temp bin directory. It
// appends one JSON line per invocation to a record file — argv, its own path, the --file content
// and mode (the file is removed by the hub afterwards) — and answers like grokmsg.py: `watch`
// prints the configured lines (then exits or stays), `read` returns the configured message,
// `reply`/`notify` succeed (or fail when configured).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GrokMessage } from '../hub/grokmsg.js';

export interface FakeGrokConfig {
  /** Lines `watch` prints on every start (`GROKMSG id=… :: preview`). */
  watchLines?: string[];
  /** Exit code after printing; undefined = keep running until killed. */
  watchExit?: number;
  messages?: Record<string, GrokMessage>;
  /** `reply` reports the push as failed (webhook not set). */
  replyNotPushed?: boolean;
  /** `reply` fails (exit 1, ok false). */
  replyFail?: boolean;
  /** `notify` fails (exit 1, ok false, a network error). */
  notifyFail?: boolean;
  /** `notify` stores the notice but cannot push (exit 1, notified.error WEBHOOK_NOT_SET). */
  webhookNotSet?: boolean;
}

export interface FakeGrokRecord {
  argv: string[];
  exe: string;
  file: string | null;
  fileMode: string | null;
  home: string | null;
}

const SCRIPT = (configPath: string, recordPath: string) => `#!${process.execPath}
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
const argv = process.argv.slice(2);
const rec = { argv, exe: process.argv[1], file: null, fileMode: null, home: process.env.GROKMSG_HOME || null };
const fi = argv.indexOf('--file');
if (fi >= 0) {
  rec.file = fs.readFileSync(argv[fi + 1], 'utf8');
  rec.fileMode = (fs.statSync(argv[fi + 1]).mode & 0o777).toString(8);
}
fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(rec) + '\\n');
const out = (o, code) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exitCode = code || 0; };
let notices = 0;
switch (argv[0]) {
  case 'watch':
    for (const l of cfg.watchLines || []) process.stdout.write(l + '\\n');
    if (cfg.watchExit !== undefined) process.exitCode = cfg.watchExit;
    else setInterval(() => {}, 1000);
    break;
  case 'read': {
    const m = (cfg.messages || {})[argv[1]];
    if (m) out({ ok: true, message: m }); else out({ ok: false, error: 'NOT_FOUND', id: argv[1] }, 1);
    break;
  }
  case 'reply':
    if (cfg.replyFail) out({ ok: false, error: 'NETWORK_ERROR', id: argv[1] }, 1);
    else out({ ok: true, id: argv[1], status: argv[argv.indexOf('--status') + 1],
          notified: { ok: !cfg.replyNotPushed } });
    break;
  case 'notify':
    if (cfg.notifyFail) out({ ok: false, id: 'n' + process.pid, notified: { ok: false, error: 'NETWORK_ERROR' } }, 1);
    else if (cfg.webhookNotSet) out({ ok: false, id: 'n' + process.pid, notified: { ok: false, error: 'WEBHOOK_NOT_SET', hint: 'the user runs: grokmsg webhook set' } }, 1);
    else out({ ok: true, id: 'n' + process.pid, notified: { ok: true } });
    break;
  default:
    out({ ok: false, error: 'UNKNOWN_COMMAND' }, 2);
}
`;

export class FakeGrok {
  readonly bin: string;
  readonly exe: string;
  readonly home: string;
  private readonly configPath: string;
  private readonly recordPath: string;

  constructor(root: string, config: FakeGrokConfig = {}) {
    this.bin = join(root, 'fake-bin');
    this.home = join(root, 'grokmsg-home');
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    this.exe = join(this.bin, 'grokmsg');
    this.configPath = join(root, 'fake-grokmsg.json');
    this.recordPath = join(root, 'fake-grokmsg.jsonl');
    this.configure(config);
    writeFileSync(this.exe, SCRIPT(this.configPath, this.recordPath));
    chmodSync(this.exe, 0o755);
  }

  configure(config: FakeGrokConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config));
  }

  /** Environment for the hub: the temp bin first on PATH, GROKMSG_HOME in temp. */
  env(): NodeJS.ProcessEnv {
    return {
      PATH: `${this.bin}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      GROKMSG_HOME: this.home,
    };
  }

  records(command?: string): FakeGrokRecord[] {
    if (!existsSync(this.recordPath)) return [];
    return readFileSync(this.recordPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as FakeGrokRecord)
      .filter((r) => command === undefined || r.argv[0] === command);
  }
}

/** A watch line as grokmsg prints it (`choice=` uses Python repr quoting). */
export function watchLine(m: GrokMessage, preview = m.text): string {
  const extra = [
    m.reply_to ? ` reply_to=${m.reply_to}` : '',
    m.choice !== undefined ? ` choice='${m.choice}'` : '',
  ].join('');
  return `GROKMSG id=${m.id} from=${m.from ?? 'grok'}${extra} :: ${preview}`;
}
