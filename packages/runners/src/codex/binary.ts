import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The Codex CLI binary bundled with the pinned `@openai/codex-sdk` (spec §2: use its own binary).
// Resolved the same way the SDK resolves it, so the runner can start it through the process-group
// wrapper (`codexPathOverride`) and run `--version` / `login status` for the probe.

const PLATFORM_PACKAGE: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
};

function targetTriple(): string | undefined {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : arch === 'x64'
        ? 'x86_64-apple-darwin'
        : undefined;
  }
  if (platform === 'linux' || platform === 'android') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-musl'
      : arch === 'x64'
        ? 'x86_64-unknown-linux-musl'
        : undefined;
  }
  return undefined;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

export interface CodexBinary {
  executable: string;
  /** Directories the SDK prepends to PATH for the binary (bundled helpers). */
  pathDirs: string[];
}

/** Locate the bundled codex binary; throws with a readable message when it is missing. */
export function resolveBundledCodex(): CodexBinary {
  const triple = targetTriple();
  const platformPackage = triple ? PLATFORM_PACKAGE[triple] : undefined;
  if (!triple || !platformPackage) {
    throw new Error(`unsupported platform for codex: ${process.platform}/${process.arch}`);
  }
  const req = createRequire(import.meta.url);
  let sdkPkg: string | undefined;
  for (const base of req.resolve.paths('@openai/codex-sdk') ?? []) {
    const candidate = join(base, '@openai', 'codex-sdk', 'package.json');
    if (existsSync(candidate)) {
      sdkPkg = realpathSync(candidate);
      break;
    }
  }
  if (!sdkPkg) throw new Error('@openai/codex-sdk is not installed');
  const codexPkg = createRequire(sdkPkg).resolve('@openai/codex/package.json');
  const platformPkg = createRequire(codexPkg).resolve(`${platformPackage}/package.json`);
  const root = join(dirname(platformPkg), 'vendor', triple);
  const packaged = join(root, 'bin', 'codex');
  if (isFile(packaged) && isFile(join(root, 'codex-package.json'))) {
    return { executable: packaged, pathDirs: [join(root, 'codex-path')].filter(isDir) };
  }
  const legacy = join(root, 'codex', 'codex');
  if (isFile(legacy)) return { executable: legacy, pathDirs: [join(root, 'path')].filter(isDir) };
  throw new Error(`codex binary for ${triple} not found under ${root}`);
}
