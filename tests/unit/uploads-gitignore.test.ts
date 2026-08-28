/**
 * The uploads directory is half-ignored, and the order is what makes it work
 * (SPEC-006).
 *
 * > `.gitignore` contains `public/uploads/*` followed by `!public/uploads/seed/`
 * > — the negation must come second or the seed assets are lost.
 *
 * Oracle: "`git check-ignore -q public/uploads/avatars/x/y.webp` exits 0 AND
 * `git check-ignore -q public/uploads/seed/demo.webp` exits 1 (seed assets stay
 * tracked)."
 *
 * ── Why git itself is invoked instead of the rules being re-implemented ────
 * The interesting failure here is not "someone deleted a line". It is the
 * ordering rule, plus gitignore's genuinely surprising directory semantics: a
 * pattern that excludes a *directory* stops git descending into it, and a later
 * negation of a file inside that directory then has no effect at all. That is
 * why the spec's wildcard is `public/uploads/*` and not `public/uploads/`, and
 * it is why re-implementing the match in TypeScript would be a test of my
 * understanding of gitignore rather than of the repository's actual behaviour.
 *
 * `git check-ignore` is the same matcher `git add` uses. If it and this suite
 * disagree, this suite is wrong.
 *
 * ── The exit codes ────────────────────────────────────────────────────────
 * `git check-ignore -q PATH` exits 0 when the path IS ignored and 1 when it is
 * not. So "exits 1" in the criterion is the assertion that seed fixtures are
 * still trackable — the double negative is in git's interface, not in the spec.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/db';

/** `true` when git considers `path` ignored. Mirrors `check-ignore`'s codes. */
function isIgnored(path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', path], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  // 0 = ignored, 1 = not ignored, 128 = fatal (not a repo, bad path spec).
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore exited ${result.status} for ${path}`);
  }
  return result.status === 0;
}

describe('SPEC-006 — user uploads are ignored, seed fixtures are tracked', () => {
  it('runs inside a git work tree, so the assertions are not vacuous', () => {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.stdout.trim()).toBe('true');
  });

  it('ignores an uploaded avatar — `check-ignore` exits 0', () => {
    expect(isIgnored('public/uploads/avatars/x/y.webp')).toBe(true);
  });

  it('does NOT ignore a seed fixture — `check-ignore` exits 1', () => {
    expect(isIgnored('public/uploads/seed/demo.webp')).toBe(false);
  });

  it('ignores every non-seed kind, not just avatars', () => {
    // The wildcard is `public/uploads/*`, so covers and inline are covered by
    // the same rule — but "covered by the same rule" is an argument, and the
    // three directories are what SPEC-006's storage table actually names.
    expect(isIgnored('public/uploads/covers/user-1/abc.webp')).toBe(true);
    expect(isIgnored('public/uploads/inline/user-1/abc.webp')).toBe(true);
  });

  it('keeps the whole seed subtree trackable, not only its top level', () => {
    expect(isIgnored('public/uploads/seed/nested/demo.webp')).toBe(false);
  });

  it('states the wildcard before the negation, which is what makes it work', () => {
    // The behavioural assertions above would also pass on a `.gitignore` that
    // got the right answer by accident. This one pins the mechanism the spec
    // calls out: the negation must come SECOND, and the wildcard must be
    // `public/uploads/*` rather than `public/uploads/` — a directory exclusion
    // stops git descending, and an un-descended directory cannot be re-included.
    const lines = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim());

    const wildcard = lines.indexOf('public/uploads/*');
    const negation = lines.indexOf('!public/uploads/seed/');

    expect(wildcard, '.gitignore is missing `public/uploads/*`').toBeGreaterThanOrEqual(0);
    expect(negation, '.gitignore is missing `!public/uploads/seed/`').toBeGreaterThanOrEqual(0);
    expect(negation, 'the negation must follow the wildcard').toBeGreaterThan(wildcard);
    expect(lines, 'a directory exclusion would make the negation unreachable').not.toContain(
      'public/uploads/',
    );
  });

  it('the seed fixtures the seeder produces are actually present and trackable', () => {
    // Ties the ignore rules to the thing they exist to protect: if
    // `scripts/uploads-seed.mjs` has run (and `npm run setup` runs it), its
    // output must be visible to git rather than silently ignored.
    const demo = join(REPO_ROOT, 'public', 'uploads', 'seed', 'demo.webp');
    if (!existsSync(demo)) {
      throw new Error(
        'public/uploads/seed/demo.webp is missing — run `node scripts/uploads-seed.mjs`',
      );
    }
    expect(isIgnored('public/uploads/seed/demo.webp')).toBe(false);
  });
});
