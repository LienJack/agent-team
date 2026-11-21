// GitPort implementation over the git CLI (spec §6, §8): worktree lifecycle, change lists,
// service-side commits, base drift (resolveRef + diffFiles), managed-worktree listing.
export { createGitPort, type CliGitPort, type GitPortOptions } from './git-port.js';
export { GitError, gitEnv } from './exec.js';
