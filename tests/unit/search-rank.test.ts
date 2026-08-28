/**
 * bm25 field weighting (SPEC-008).
 *
 * > A term appearing only in an article title ranks above an article
 * > containing it only in the body.
 *
 * > | Rank | `bm25(article_fts, 10.0, 5.0, 1.0)` — title weighted 10×,
 * >   subtitle 5×, body 1× |
 *
 * ── Why the fixture is built to be hostile to the weighting ───────────────
 * The title-beats-body assertion passes trivially if the title article is also
 * shorter, or newer, or the only one that matches — bm25 rewards a match in a
 * short field regardless of weights. So the fixture stacks the deck the other
 * way: the BODY article mentions the term repeatedly, in a long body, while
 * the TITLE article mentions it exactly once and never again. If the weights
 * were dropped — `bm25(article_fts)` with no arguments weights every column
 * equally — term frequency alone would put the body article first, and this
 * file goes red.
 *
 * The subtitle case is the middle of the same argument, and it is here because
 * SPEC-008 gives subtitle its own weight (5×) rather than folding it into
 * body. A two-point ordering cannot distinguish "title is weighted" from "the
 * weights are 10, 1, 1".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import { BM25_WEIGHTS, ensureSearchIndex, searchArticles } from '../../lib/search/fts';

const NOW = new Date('2026-07-01T00:00:00.000Z');

/** A word that appears nowhere else in the fixture or the corpus. */
const TERM = 'wombat';

const TITLE_ID = 'a0000000000000000000000001';
const SUBTITLE_ID = 'a0000000000000000000000002';
const BODY_ID = 'a0000000000000000000000003';
const UNRELATED_ID = 'a0000000000000000000000004';

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** Long filler so the body article's field length does not flatter it. */
const FILLER = 'The quick brown fox jumps over the lazy dog. '.repeat(12);

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

  const write = async (id: string, title: string, subtitle: string | null, body: string) => {
    await createArticle({
      id,
      authorId: author.id,
      title,
      subtitle,
      bodyJson: doc(body),
      bodyHtml: `<p>${body}</p>`,
      status: 'PUBLISHED',
      now: NOW,
    });
  };

  // Title only — one occurrence, and never again anywhere in the row.
  await write(TITLE_ID, `The ${TERM} papers`, 'A study of habits', FILLER);
  // Subtitle only.
  await write(SUBTITLE_ID, 'A study of habits', `Notes on the ${TERM}`, FILLER);
  // Body only — SIX occurrences, which is what makes this test worth running.
  await write(
    BODY_ID,
    'A study of habits',
    'Field notes',
    `${FILLER} ${`Every paragraph mentions the ${TERM} again. `.repeat(6)}`,
  );
  await write(UNRELATED_ID, 'Something else entirely', 'No relation', FILLER);

  await ensureSearchIndex();
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

describe('SPEC-008 — bm25 field weighting', () => {
  it('weights title 10x, subtitle 5x, body 1x — positionally', () => {
    // The order is load-bearing: bm25's weights are positional and match the
    // column order the migration created. This pins the constant so a
    // reordering is a test failure rather than a silent re-weighting.
    expect([...BM25_WEIGHTS]).toEqual([10.0, 5.0, 1.0]);
  });

  it('ranks a title match above a body match', async () => {
    const hits = await searchArticles(TERM, { limit: 10 });
    const ids = hits.map((hit) => hit.id);

    expect(ids).toContain(TITLE_ID);
    expect(ids).toContain(BODY_ID);
    expect(ids.indexOf(TITLE_ID)).toBeLessThan(ids.indexOf(BODY_ID));
  });

  it('ranks a title match above a subtitle match, and subtitle above body', async () => {
    const ids = (await searchArticles(TERM, { limit: 10 })).map((hit) => hit.id);
    expect(ids.indexOf(TITLE_ID)).toBeLessThan(ids.indexOf(SUBTITLE_ID));
    expect(ids.indexOf(SUBTITLE_ID)).toBeLessThan(ids.indexOf(BODY_ID));
  });

  it('does the ranking on merit, not on term frequency alone', async () => {
    // Guards the fixture itself. If a future edit trimmed the body article's
    // repetitions, the ordering assertions above would still pass — but they
    // would have stopped testing the weights, which is the whole point.
    const hits = await searchArticles(TERM, { limit: 10 });
    const body = hits.find((hit) => hit.id === BODY_ID);
    expect(body?.bodyText.split(TERM).length).toBeGreaterThan(5);
  });

  it('returns matches best-first, with a score that increases toward the front', async () => {
    const hits = await searchArticles(TERM, { limit: 10 });
    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('excludes articles that do not match at all', async () => {
    const ids = (await searchArticles(TERM, { limit: 10 })).map((hit) => hit.id);
    expect(ids).not.toContain(UNRELATED_ID);
    expect(ids).toHaveLength(3);
  });

  it('carries a snippet centred on the match for a body hit', async () => {
    const hits = await searchArticles(TERM, { limit: 10 });
    const body = hits.find((hit) => hit.id === BODY_ID);
    expect(body?.snippet).toContain(`<mark>${TERM}</mark>`);
  });

  it('stems, so a plural query finds the singular', async () => {
    // `porter unicode61` is what the migration asked for; without the porter
    // stemmer this returns nothing.
    const ids = (await searchArticles(`${TERM}s`, { limit: 10 })).map((hit) => hit.id);
    expect(ids).toContain(TITLE_ID);
  });

  it('intersects multiple terms rather than unioning them', async () => {
    // "wombat papers" must not return the body article, which has `wombat` in
    // abundance and `papers` nowhere. An OR would return all three.
    const ids = (await searchArticles(`${TERM} papers`, { limit: 10 })).map((hit) => hit.id);
    expect(ids).toEqual([TITLE_ID]);
  });
});
