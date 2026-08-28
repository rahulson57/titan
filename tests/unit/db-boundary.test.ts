/**
 * The persistence boundary (SPEC-004).
 *
 * > No file outside `lib/db/**` imports `@prisma/client` or `better-sqlite3`.
 *
 * This is the criterion that makes "all other modules read/write through the
 * typed repository functions" enforceable rather than aspirational. The rule is
 * worth more than tidiness: `lib/db/client.ts` is where WAL, `foreign_keys=ON`,
 * `busy_timeout` and the single-connection pool are established, so a module
 * that constructs its own `PrismaClient` gets a connection with foreign keys
 * OFF — and every cascade SPEC-004 relies on silently stops happening. That
 * failure is invisible in development and shows up as orphan rows much later.
 *
 * The check walks the repository's own source rather than parsing imports out
 * of a build, so it holds for files no test currently imports.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../helpers/db';

/** The forbidden specifiers, verbatim from the criterion. */
const FORBIDDEN = ['@prisma/client', 'better-sqlite3'];

/** Directories that hold product or test source. */
const ROOTS = ['app', 'components', 'lib', 'prisma', 'scripts', 'tests', 'middleware.ts'];

const IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'coverage',
  'data',
  'playwright-report',
  'test-results',
  'migrations',
]);

/**
 * The one file outside `lib/db/**` allowed to name a forbidden specifier, and
 * why.
 *
 * `tests/helpers/db.ts` (owned by SPEC-002) builds throwaway databases for
 * integration suites. It reaches the client through a NON-LITERAL dynamic
 * specifier and a structural `RawClient` interface precisely so it takes no
 * compile-time dependency on the generated client — which is what lets
 * `tsc --noEmit` pass on a tree where Persistence has not landed. It is a test
 * fixture, not a module of the app, and it never sees the app connection.
 */
const ALLOWED_OUTSIDE_LIB_DB = new Set([
  'tests/helpers/db.ts',
  // This file. It names the forbidden specifiers in order to forbid them; a
  // scan that flagged its own rule would be unwritable.
  'tests/unit/db-boundary.test.ts',
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (absolute: string) => {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return; // a root a later slice has not created yet
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const child = join(absolute, entry);
      const stats = statSync(child);
      if (stats.isDirectory()) walk(child);
      else if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry)) out.push(child);
    }
  };

  for (const root of ROOTS) {
    const absolute = join(REPO_ROOT, root);
    try {
      if (statSync(absolute).isDirectory()) walk(absolute);
      else out.push(absolute);
    } catch {
      /* not present yet */
    }
  }
  return out;
}

const posix = (absolute: string) => relative(REPO_ROOT, absolute).split(sep).join('/');
const isRepository = (path: string) => path.startsWith('lib/db/');

describe('SPEC-004 — lib/db is the only path to the database', () => {
  const files = sourceFiles().map((absolute) => ({
    path: posix(absolute),
    source: readFileSync(absolute, 'utf8'),
  }));

  it('finds source to check, so a broken walk cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.path)).toContain('lib/db/client.ts');
    expect(files.map((f) => f.path)).toContain('prisma/seed.ts');
  });

  it.each(FORBIDDEN)('nothing outside lib/db imports %s', (specifier) => {
    const offenders = files
      .filter(({ path }) => !isRepository(path) && !ALLOWED_OUTSIDE_LIB_DB.has(path))
      .filter(({ source }) => source.includes(specifier))
      .map(({ path }) => path);

    expect(
      offenders,
      `${offenders.join(', ')} reaches the database directly. Add a function to ` +
        'lib/db/ and call that instead — a client built anywhere else runs with ' +
        'foreign_keys OFF and every cascade in SPEC-004 stops happening.',
    ).toEqual([]);
  });

  it('nothing outside lib/db constructs its own client', () => {
    const offenders = files
      .filter(({ path }) => !isRepository(path) && !ALLOWED_OUTSIDE_LIB_DB.has(path))
      .filter(({ source }) => /new\s+PrismaClient\s*\(/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('the seed script goes through the repository layer like everything else', () => {
    // The seed is the most tempting place to open a raw handle — it writes the
    // most rows and cares the most about speed. It uses `getDb()` instead.
    const seed = files.find((f) => f.path === 'prisma/seed.ts');
    expect(seed?.source).toMatch(/from '\.\.\/lib\/db\/client'/);
    for (const specifier of FORBIDDEN) expect(seed?.source).not.toContain(specifier);
  });

  it('the repository layer itself does import the client — the rule is a boundary, not a ban', () => {
    const client = files.find((f) => f.path === 'lib/db/client.ts');
    expect(client?.source).toContain("from '@prisma/client'");
  });
});
