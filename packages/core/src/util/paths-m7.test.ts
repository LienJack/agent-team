import { describe, expect, it } from 'vitest';
import { filesOutside, isPathOwned, normalizeOwnedPath, ownedPathsOverlap } from './paths.js';

describe('M7 "." means the whole repository in both checks', () => {
  it('normalises . and ./ to the repo root', () => {
    expect(normalizeOwnedPath('.')).toBe('');
    expect(normalizeOwnedPath('./')).toBe('');
    expect(normalizeOwnedPath('./src/')).toBe('src');
  });

  it('owns every file', () => {
    expect(isPathOwned('a/b/c.ts', ['.'])).toBe(true);
    expect(isPathOwned('README.md', ['./'])).toBe(true);
  });

  it('overlaps every other task (it was treated as a directory named ".")', () => {
    expect(ownedPathsOverlap(['.'], ['src/x/'])).toBe(true);
    expect(ownedPathsOverlap(['src/x/'], ['./'])).toBe(true);
    expect(ownedPathsOverlap(['./src/a'], ['src/a/b.ts'])).toBe(true);
  });

  it('does not let a "." segment or a trailing dot sneak past ownership', () => {
    expect(isPathOwned('src/feature/../../etc/x', ['src/feature/'])).toBe(false);
    expect(filesOutside(['src/a/./b.ts'], ['src/a/'])).toEqual([]);
  });
});

describe('M7 case-insensitive comparison', () => {
  it('compares case-insensitively only when asked', () => {
    expect(isPathOwned('SRC/Feature/a.ts', ['src/feature/'])).toBe(false);
    expect(isPathOwned('SRC/Feature/a.ts', ['src/feature/'], { ignoreCase: true })).toBe(true);
    expect(ownedPathsOverlap(['src/A/'], ['src/a/x.ts'])).toBe(false);
    expect(ownedPathsOverlap(['src/A/'], ['src/a/x.ts'], { ignoreCase: true })).toBe(true);
    expect(isPathOwned('Src/a.TS', ['src/**/*.ts'], { ignoreCase: true })).toBe(true);
  });
});
