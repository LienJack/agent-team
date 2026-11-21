import { describe, expect, it } from 'vitest';
import { filesOutside, isPathOwned, normalizeOwnedPath, ownedPathsOverlap } from './paths.js';

// macOS file names may reach the engine in either Unicode form: a ticket typed on one machine
// (NFC, `é` = U+00E9) and git's output or another ticket in decomposed form (NFD, `e` + U+0301)
// name the same file. Both sides are compared in NFC, so ownership is not refused by mistake and
// two tasks on the same file are seen to overlap.

const nfc = 'docs/café/menü.md';
const nfd = nfc.normalize('NFD');

describe('owned paths: Unicode normalisation (NFC)', () => {
  it('the two spellings really differ as strings', () => {
    expect(nfc).not.toBe(nfd);
    expect(nfd.normalize('NFC')).toBe(nfc);
  });

  it('normalises to NFC', () => {
    expect(normalizeOwnedPath(nfd)).toBe(nfc);
  });

  it('an NFD owned path owns the NFC file and the other way round', () => {
    expect(isPathOwned(nfc, [nfd])).toBe(true);
    expect(isPathOwned(nfd, [nfc])).toBe(true);
    expect(
      isPathOwned(`${nfc.normalize('NFD').split('/').slice(0, 2).join('/')}/x.md`, ['docs/café']),
    ).toBe(true);
    expect(filesOutside([nfc], [nfd])).toEqual([]);
    expect(isPathOwned('docs/café/*.md'.normalize('NFD'), ['docs/café/*.md'])).toBe(true);
  });

  it('detects overlap across the two forms', () => {
    expect(ownedPathsOverlap([nfc], [nfd])).toBe(true);
    expect(ownedPathsOverlap(['docs/café'], [`${'docs/café'.normalize('NFD')}/*.md`])).toBe(true);
    expect(ownedPathsOverlap(['docs/cafe'], [nfd])).toBe(false);
  });
});
