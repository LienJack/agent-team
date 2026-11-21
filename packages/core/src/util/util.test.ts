import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from './hash.js';
import { filesOutside, isPathOwned, ownedPathsOverlap } from './paths.js';
import { backoffMs, lastLines } from './time.js';

describe('owned_paths matching', () => {
  it('literal paths own themselves and their subtree', () => {
    expect(isPathOwned('src/a.ts', ['src/a.ts'])).toBe(true);
    expect(isPathOwned('src/feature/x/y.ts', ['src/feature'])).toBe(true);
    expect(isPathOwned('src/feature/x/y.ts', ['src/feature/'])).toBe(true);
    expect(isPathOwned('./src/feature/y.ts', ['src/feature/'])).toBe(true);
    expect(isPathOwned('src/featureX/y.ts', ['src/feature'])).toBe(false);
    expect(isPathOwned('docs/a.md', ['src/'])).toBe(false);
  });

  it('globs: *, ** and ?', () => {
    expect(isPathOwned('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(isPathOwned('src/x/a.ts', ['src/*.ts'])).toBe(false);
    expect(isPathOwned('src/x/y/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(isPathOwned('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(isPathOwned('src/a.js', ['src/**/*.ts'])).toBe(false);
    expect(isPathOwned('pkg1/x', ['pkg?/'])).toBe(true);
    expect(isPathOwned('anything/at/all', ['**'])).toBe(true);
  });

  it('lists files outside', () => {
    expect(filesOutside(['src/a.ts', 'README.md', 'src/b/c.ts'], ['src/'])).toEqual(['README.md']);
  });
});

describe('owned_paths overlap', () => {
  it('detects prefix overlap between literals and globs', () => {
    expect(ownedPathsOverlap(['src/a/'], ['src/a/b.ts'])).toBe(true);
    expect(ownedPathsOverlap(['src/a/b.ts'], ['src/a/'])).toBe(true);
    expect(ownedPathsOverlap(['src/a/'], ['src/b/'])).toBe(false);
    expect(ownedPathsOverlap(['src/a/**'], ['src/a/x.ts'])).toBe(true);
    expect(ownedPathsOverlap(['src/*.ts'], ['lib/'])).toBe(false);
    expect(ownedPathsOverlap(['src/ab'], ['src/a'])).toBe(false);
  });

  it('treats uncertain patterns as overlapping', () => {
    expect(ownedPathsOverlap(['**/*.md'], ['src/x'])).toBe(true);
    expect(ownedPathsOverlap([], ['src/x'])).toBe(true);
    expect(ownedPathsOverlap(['*.json'], ['package.json'])).toBe(true);
  });
});

describe('hashing', () => {
  it('sha256 matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    expect(sha256Hex('中文')).toHaveLength(64);
  });

  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('time helpers', () => {
  it('exponential backoff from 5s capped at 5 min', () => {
    expect([1, 2, 3, 4, 7, 8, 50].map((n) => backoffMs(n, 5000, 300000))).toEqual([
      5000, 10000, 20000, 40000, 300000, 300000, 300000,
    ]);
  });

  it('lastLines keeps the tail', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const tail = lastLines(`${text}\n`, 20).split('\n');
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe('line 11');
    expect(tail[19]).toBe('line 30');
  });
});
