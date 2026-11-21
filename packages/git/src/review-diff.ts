import type { ReviewDiff } from '@agent-team/core';

// The review diff (docs/adr/0008): read-only reviewers cannot run git, so the engine puts the
// change into their prompt. A patch is split into its per-file `diff --git` sections (content
// lines always start with ' ', '+', '-' or '\', so a section header can only start a section),
// and whole sections are kept in diff order while they fit in the character budget.

const SECTION_RE = /^(?=diff --git )/m;

/** Per-file sections of a unified diff (`git diff --patch` output), in order. */
export function splitDiffSections(patch: string): string[] {
  if (patch.trim() === '') return [];
  return patch
    .split(SECTION_RE)
    .filter((s) => s.startsWith('diff --git '))
    .map((s) => (s.endsWith('\n') ? s : `${s}\n`));
}

/** Path named by a section header (`diff --git a/x b/y` → `y`); quoted paths are kept quoted. */
export function sectionPath(section: string): string {
  const nl = section.indexOf('\n');
  const header = nl < 0 ? section : section.slice(0, nl);
  const at = header.lastIndexOf(' b/');
  return at >= 0 ? header.slice(at + 3) : header.slice('diff --git '.length);
}

/**
 * Keep whole sections while the total stays within `maxChars` (smaller later sections may still
 * fit after a large one is left out). `names` (from `--name-only -z`, same diff options) label
 * the sections when the counts agree; otherwise the headers are parsed.
 */
export function fillReviewDiff(
  stat: string,
  patch: string,
  names: readonly string[],
  maxChars: number,
): ReviewDiff {
  const sections = splitDiffSections(patch);
  const label = (i: number) =>
    names.length === sections.length ? names[i]! : sectionPath(sections[i]!);
  let diff = '';
  const omittedFiles: string[] = [];
  sections.forEach((section, i) => {
    if (diff.length + section.length <= maxChars) diff += section;
    else omittedFiles.push(label(i));
  });
  return { stat, diff, truncated: omittedFiles.length > 0, omittedFiles };
}
