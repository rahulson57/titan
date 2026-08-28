/**
 * FTS5 operators typed by a reader (SPEC-008).
 *
 * > Search input of `"`, `*`, `AND`, and `foo NEAR/2 bar` returns a result set
 * > without throwing (operators treated as literal terms).
 *
 * > User input is escaped and joined as quoted terms.
 *
 * ── The control experiment ────────────────────────────────────────────────
 * The first block below sends each of the four inputs to `MATCH` RAW, and
 * asserts that every one of them throws. That is not padding: without it,
 * "returns a result set without throwing" is satisfied by a search that never
 * reaches FTS5 at all — a `LIKE` fallback, a swallowed exception, or a parser
 * that returns `[]` for anything it does not recognise would all pass the
 * happy-path assertions while quietly having no full-text search.
 *
 * The control makes the second block mean something. It says: these four
 * inputs really are hostile to this database, and the product handles them
 * anyway. If SQLite is ever built with a more forgiving parser, the control
 * fails first and tells you the second block has stopped proving anything.
 *
 * Binding a parameter does NOT help here, and that is the trap worth naming.
 * `MATCH ?` binds the string and then FTS5 parses it as a query language, so
 * the reflex that protects every other query in this codebase protects nothing
 * here. Quoting is the fix, not binding.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb, getDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import { ensureSearchIndex, searchArticles } from '../../lib/search/fts';
import {
  MAX_SEARCH_TERMS,
  MAX_TERM_LENGTH,
  parseSearchQuery,
  quoteTerm,
} from '../../lib/search/query';

const NOW = new Date('2026-09-01T00:00:00.000Z');

/** The four inputs the criterion names, verbatim. */
const HOSTILE = ['"', '*', 'AND', 'foo NEAR/2 bar'] as const;

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  const author = await createUser({
    email: 'author@titan.test',
    passwordHash: 'x',
    handle: 'author',
    name: 'Author',
  });

  // One article containing the literal word "and", so `?q=AND` can be shown to
  // search for the WORD rather than to be parsed as a boolean or to be
  // silently dropped.
  await createArticle({
    id: 'a0000000000000000000000001',
    authorId: author.id,
    title: 'Salt and pepper',
    subtitle: null,
    bodyJson: doc('A short note about seasoning and restraint.'),
    bodyHtml: '<p>x</p>',
    status: 'PUBLISHED',
    now: NOW,
  });

  await createArticle({
    id: 'a0000000000000000000000002',
    authorId: author.id,
    title: 'Unrelated entirely',
    subtitle: null,
    bodyJson: doc('Nothing in common with the other one.'),
    bodyHtml: '<p>x</p>',
    status: 'PUBLISHED',
    now: NOW,
  });

  await ensureSearchIndex();
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

describe('the control experiment — these inputs really are hostile', () => {
  it.each(HOSTILE)('raw MATCH %j is an FTS5 error', async (input) => {
    await expect(
      getDb().$queryRawUnsafe(`SELECT rowid FROM "article_fts" WHERE "article_fts" MATCH ?`, input),
    ).rejects.toThrow();
  });
});

describe('SPEC-008 — the four inputs the criterion names', () => {
  it.each(HOSTILE)('%j returns a result set without throwing', async (input) => {
    const results = await searchArticles(input);
    expect(Array.isArray(results)).toBe(true);
  });

  it('treats AND as a literal term, not as a boolean operator', async () => {
    const ids = (await searchArticles('AND')).map((hit) => hit.id);
    // The article whose title is "Salt and pepper" contains the word; the
    // other does not. A boolean AND with no operands would be a syntax error;
    // a dropped stop-word would return nothing.
    expect(ids).toEqual(['a0000000000000000000000001']);
  });

  it('treats NEAR/2 as words rather than a proximity operator', async () => {
    // `foo`, `near`, `2` and `bar` are all absent, and the three quoted tokens
    // are ANDed, so the honest answer is no results — reached without an
    // exception, which is the criterion.
    expect(await searchArticles('foo NEAR/2 bar')).toEqual([]);
  });

  it('handles a query that is nothing but punctuation', async () => {
    for (const input of ['***', '""""', '^^^', '- - -', '/', ')']) {
      expect(await searchArticles(input)).toEqual([]);
    }
  });

  it('returns nothing for an empty or whitespace query, without reaching FTS5', async () => {
    // `MATCH ''` is itself a syntax error, so the empty search box would 500
    // if the early return were removed.
    expect(await searchArticles('')).toEqual([]);
    expect(await searchArticles('   \t\n ')).toEqual([]);
  });

  it('still finds ordinary words, so the escaping did not break search', async () => {
    const ids = (await searchArticles('seasoning')).map((hit) => hit.id);
    expect(ids).toEqual(['a0000000000000000000000001']);
  });
});

describe('SPEC-008 — the parser', () => {
  it('quotes each token and joins them with spaces', () => {
    expect(parseSearchQuery('design systems').match).toBe('"design" "systems"');
  });

  it('doubles an embedded double quote, the way SQL does', () => {
    expect(quoteTerm('say "hi"')).toBe('"say ""hi"""');
    expect(parseSearchQuery('"').match).toBe('""""');
  });

  it('reports emptiness rather than producing an empty MATCH expression', () => {
    for (const input of ['', '   ', null, undefined]) {
      const parsed = parseSearchQuery(input);
      expect(parsed.isEmpty).toBe(true);
      expect(parsed.terms).toEqual([]);
      expect(parsed.match).toBe('');
    }
  });

  it('echoes the trimmed input back for the UI', () => {
    expect(parseSearchQuery('  design systems  ').raw).toBe('design systems');
  });

  it('caps the number of terms', () => {
    const many = Array.from({ length: MAX_SEARCH_TERMS + 20 }, (_, i) => `t${i}`).join(' ');
    expect(parseSearchQuery(many).terms).toHaveLength(MAX_SEARCH_TERMS);
  });

  it('truncates an absurdly long token rather than sending it', () => {
    const long = 'x'.repeat(MAX_TERM_LENGTH * 3);
    const [term] = parseSearchQuery(long).terms;
    expect(term).toHaveLength(MAX_TERM_LENGTH);
  });

  it('survives a query long enough to be an attack', async () => {
    const flood = Array.from({ length: 5_000 }, () => 'wombat').join(' ');
    expect(parseSearchQuery(flood).terms).toHaveLength(MAX_SEARCH_TERMS);
    expect(await searchArticles(flood)).toEqual([]);
  });
});
