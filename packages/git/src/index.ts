// GitPort implementation over the git CLI (spec §6, §8): worktree lifecycle, change lists,
// service-side commits, base drift (resolveRef + diffFiles), managed-worktree listing.
export { createGitPort, DEFAULT_AUTHOR, type CliGitPort, type GitPortOptions } from './git-port.js';
export { fillReviewDiff, splitDiffSections } from './review-diff.js';
export { GitError, gitEnv } from './exec.js';
export {
  createGateGit,
  type GateGit,
  type GateGitOptions,
  type GateInspection,
  type GateWorktree,
} from './gate.js';
