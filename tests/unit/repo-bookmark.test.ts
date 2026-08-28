/**
 * The `/bookmarks` repository query (SPEC-011, via `lib/db/social.ts`).
 *
 * > "Reverse-chronological by `Bookmark.createdAt`, cursor-paginated at page
 * >  size 20."
 *
 * ── Why this file exists, and why it is not an e2e test ────────────────────
 * `tests/e2e/bookmarks.spec.ts` drives the rendered library and proves the page
 * works. It cannot prove the pagination is correct, and the gap is structural
 * rather than a matter of effort: SPEC-011 fixes the page size at 20, so an
 * e2e test of a cursor boundary needs 21+ bookmarked articles standing behind a
 * signed-in session, and it can only observe what the first page renders. The
 * defects that actually live in cursor pagination — a row repeated across a
 * boundary, a row skipped, a `nextCursor` that is non-null on the last page and
 * yields an empty page — are invisible from there.
 *
 * The case that made this file necessary is the tie. `Bookmark.createdAt` is
 * NOT unique: a reader saving two articles in the same tick produces one, and
 * SPEC-002's seed corpus produces them by construction, because determinism
 * requires a fixed clock. `listBookmarkedArticles` orders by
 * `createdAt DESC, articleId DESC` for exactly that reason. Nothing was
 * asserting the second half of that pair — and a cursor over a non-total order
 * fails only once the data has ties, which is to say in front of a reader
 * rather than in a three-row fixture.
 *
 * Authorised as DEC-032. The four properties below are the ones that decision
 * names; the rest of the file closes the four untested bookmark functions
 * (`isBookmarked`, `toggleBookmark`, `removeBookmark`, `countBookmarks`) while
 * the fixture is standing, since they cost nothing extra once it is.
 *
 * ── The fixture's ids are deterministic on purpose ─────────────────────────
 * `createArticle` accepts an explicit id, so every article here gets one of the
 * form `a0000000000000000000000NN`. Two things follow. The tiebreak order is
 * then *stated* by the test rather than discovered from it — `articleId DESC`
 * is `...05, ...04, ...03` — so a failure reports which row moved, not merely
 * that something did. And the ids satisfy `isValidId`, so the fixture is
 * exercising the same shape the id generator emits rather than a convenient
 * fiction.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { isValidId } from '../../lib/db/ids';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import { attachTag } from '../../lib/db/tags';
import {
  BOOKMARKS_PAGE_SIZE,
  countBookmarks,
  isBookmarked,
  listBookmarkedArticles,
  removeBookmark,
  toggleBookmark,
} from '../../lib/db/social';

/**
 * Every bookmark in the tie fixture carries this exact instant.
 *
 * One shared constant rather than `new Date()` per row: the whole point of the
 * fixture is that `createdAt` cannot discriminate, and two calls to the clock
 * milliseconds apart would quietly restore a total order and make the tiebreak
 * assertions pass without testing anything.
 */
const SAME_TICK = new Date('2026-03-01T12:00:00.000Z');

/** A distinct, strictly-decreasing instant per index, for the ordering tests. */
function tickFor(index: number): Date {
  return new Date(SAME_TICK.getTime() - index * 60_000);
}

/** `a` + 25 digits — 26 characters, and a valid id by `isValidId`. */
function articleIdFor(index: number): string {
  return `a${String(index).padStart(25, '0')}`;
}

let db: TestDatabase;
let readerId = '';
let otherReaderId = '';
let authorId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  // Order matters: children before parents, because `foreign_keys=ON` is
  // established on the app connection and these are raw deletes.
  await db.client.$executeRawUnsafe('DELETE FROM "Bookmark"');
  await db.client.$executeRawUnsafe('DELETE FROM "ArticleTag"');
  await db.client.$executeRawUnsafe('DELETE FROM "Tag"');
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  const author = await createUser({
    email: 'author@titan.local',
    passwordHash: 'x',
    handle: 'author',
    name: 'The Author',
    createdAt: SAME_TICK,
  });
  authorId = author.id;

  const reader = await createUser({
    email: 'reader@titan.local',
    passwordHash: 'x',
    handle: 'reader',
    name: 'The Reader',
    createdAt: SAME_TICK,
  });
  readerId = reader.id;

  const other = await createUser({
    email: 'other@titan.local',
    passwordHash: 'x',
    handle: 'other',
    name: 'Another Reader',
    createdAt: SAME_TICK,
  });
  otherReaderId = other.id;
});

/** Create article number `index` with a deterministic id. */
async function makeArticle(index: number, status: 'DRAFT' | 'PUBLISHED' = 'PUBLISHED') {
  return createArticle({
    id: articleIdFor(index),
    authorId,
    title: `Article ${index}`,
    subtitle: `Subtitle ${index}`,
    bodyJson: { type: 'doc', content: [{ type: 'text', text: `Body of article ${index}` }] },
    bodyHtml: `<p>Body of article ${index}</p>`,
    status,
    now: SAME_TICK,
  });
}

/**
 * `count` articles, all bookmarked by the reader at the SAME instant.
 *
 * Returns the ids in the order the query must produce them — `articleId DESC`,
 * since every `createdAt` is identical and the composite key is the only
 * remaining discriminator.
 */
async function seedTiedBookmarks(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    await makeArticle(i);
    await toggleBookmark(readerId, articleIdFor(i), SAME_TICK);
    ids.push(articleIdFor(i));
  }
  return [...ids].reverse();
}

/**
 * Walk every page, following `nextCursor` until it is null.
 *
 * Returns the ids in traversal order plus the per-page cursors, so a test can
 * assert on the SHAPE of the traversal (how many pages, where the cursor went
 * null) and not only on the flattened result. A bounded loop, because the
 * failure this file exists to catch — a cursor that does not advance — is an
 * infinite one, and a suite that hangs reports nothing at all.
 */
async function walkAllPages(take: number): Promise<{
  ids: string[];
  pages: string[][];
  cursors: (string | null)[];
}> {
  const ids: string[] = [];
  const pages: string[][] = [];
  const cursors: (string | null)[] = [];

  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = await listBookmarkedArticles(readerId, { cursor, take });
    const pageIds = page.items.map((item) => item.id);
    pages.push(pageIds);
    cursors.push(page.nextCursor);
    ids.push(...pageIds);
    if (page.nextCursor === null) return { ids, pages, cursors };
    cursor = page.nextCursor;
  }
  throw new Error('listBookmarkedArticles never returned a null nextCursor — the cursor is not advancing');
}

// ---------------------------------------------------------------------------
// The four functions the page calls
// ---------------------------------------------------------------------------

describe('SPEC-011 — the bookmark toggle and its counters', () => {
  it('reports an article as un-bookmarked before anything is saved', async () => {
    await makeArticle(1);
    expect(await isBookmarked(readerId, articleIdFor(1))).toBe(false);
    expect(await countBookmarks(readerId)).toBe(0);
  });

  it('toggles on, then off, returning the RESULTING state each time', async () => {
    await makeArticle(1);

    // The resulting state, not the previous one: SPEC-009's optimistic UI rolls
    // back to exactly what the server holds, and a toggle that answered "what
    // it was" would have every rollback land on the wrong value.
    expect(await toggleBookmark(readerId, articleIdFor(1), SAME_TICK)).toEqual({
      bookmarked: true,
    });
    expect(await isBookmarked(readerId, articleIdFor(1))).toBe(true);
    expect(await countBookmarks(readerId)).toBe(1);

    expect(await toggleBookmark(readerId, articleIdFor(1), SAME_TICK)).toEqual({
      bookmarked: false,
    });
    expect(await isBookmarked(readerId, articleIdFor(1))).toBe(false);
    expect(await countBookmarks(readerId)).toBe(0);
  });

  it('never accumulates a second row for the same (reader, article)', async () => {
    await makeArticle(1);
    for (let i = 0; i < 5; i++) await toggleBookmark(readerId, articleIdFor(1), SAME_TICK);

    // Five toggles is an odd number, so the row should exist — and there should
    // be exactly one. The composite primary key guarantees it, and this asserts
    // the toggle is actually going through that key rather than inserting.
    const rows = await db.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT COUNT(*) AS n FROM "Bookmark"',
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(await isBookmarked(readerId, articleIdFor(1))).toBe(true);
  });

  it('removes an existing bookmark and treats a missing one as a no-op', async () => {
    await makeArticle(1);
    await toggleBookmark(readerId, articleIdFor(1), SAME_TICK);

    await removeBookmark(readerId, articleIdFor(1));
    expect(await isBookmarked(readerId, articleIdFor(1))).toBe(false);

    // `deleteMany`, not `delete` — removing a bookmark that is not there is the
    // ordinary outcome of a double-click on the inline control, and it must not
    // throw. `delete` would raise P2025 and surface as a 500.
    await expect(removeBookmark(readerId, articleIdFor(1))).resolves.toBeUndefined();
    expect(await countBookmarks(readerId)).toBe(0);
  });

  it('keeps each reader’s library separate', async () => {
    await makeArticle(1);
    await makeArticle(2);

    await toggleBookmark(readerId, articleIdFor(1), SAME_TICK);
    await toggleBookmark(otherReaderId, articleIdFor(1), SAME_TICK);
    await toggleBookmark(otherReaderId, articleIdFor(2), SAME_TICK);

    expect(await countBookmarks(readerId)).toBe(1);
    expect(await countBookmarks(otherReaderId)).toBe(2);

    // The un-toggle must be scoped too. Without the `userId` in the where
    // clause this would empty both libraries and the counts above would still
    // have passed.
    await toggleBookmark(readerId, articleIdFor(1), SAME_TICK);
    expect(await countBookmarks(readerId)).toBe(0);
    expect(await countBookmarks(otherReaderId)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('SPEC-011 — a bookmark row carries what the library renders and no more', () => {
  it('projects the article, its author and its tags, with bookmarkedAt distinct from the article dates', async () => {
    await makeArticle(1);
    await attachTag(articleIdFor(1), 'Design Systems');
    const savedAt = new Date('2026-04-02T09:30:00.000Z');
    await toggleBookmark(readerId, articleIdFor(1), savedAt);

    const page = await listBookmarkedArticles(readerId);
    const item = page.items[0];

    expect(item).toBeDefined();
    expect(item?.title).toBe('Article 1');
    expect(item?.author).toEqual({ name: 'The Author', handle: 'author', avatarPath: null });
    expect(item?.tags).toEqual([{ slug: 'design-systems', name: 'Design Systems' }]);

    // The two dates mean different things — when the reader saved it versus
    // when the article was created — and collapsing them is how a byline ends
    // up showing the wrong date.
    expect(item?.bookmarkedAt.toISOString()).toBe(savedAt.toISOString());
    expect(item?.createdAt.toISOString()).toBe(SAME_TICK.toISOString());

    // `bodyJson`/`bodyHtml` are the two largest columns in the schema and the
    // library renders neither. Asserting their ABSENCE is what keeps a future
    // `select` from quietly adding them back and doubling the payload of every
    // page of 20.
    expect(item).not.toHaveProperty('bodyJson');
    expect(item).not.toHaveProperty('bodyHtml');
    expect(item?.bodyText).toContain('Body of article 1');
  });

  it('keeps a bookmark whose article was later unpublished', async () => {
    // Deliberate, and documented on `listBookmarkedArticles`: filtering DRAFT
    // rows out here would make saved items silently vanish from a personal
    // library. Draft privacy is enforced by the article page (404 for a
    // non-author), so the link goes nowhere for anyone who may not read it.
    await makeArticle(1, 'DRAFT');
    await toggleBookmark(readerId, articleIdFor(1), SAME_TICK);

    const page = await listBookmarkedArticles(readerId);
    expect(page.items.map((item) => item.id)).toEqual([articleIdFor(1)]);
    expect(page.items[0]?.status).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('SPEC-011 — newest save first, with a total order', () => {
  it('sorts by bookmarkedAt descending', async () => {
    for (let i = 1; i <= 4; i++) {
      await makeArticle(i);
      // Article 1 saved longest ago, article 4 most recently.
      await toggleBookmark(readerId, articleIdFor(i), tickFor(4 - i));
    }

    const page = await listBookmarkedArticles(readerId);
    expect(page.items.map((item) => item.id)).toEqual([
      articleIdFor(4),
      articleIdFor(3),
      articleIdFor(2),
      articleIdFor(1),
    ]);
  });

  it('breaks a createdAt tie by articleId descending', async () => {
    const expected = await seedTiedBookmarks(5);

    const page = await listBookmarkedArticles(readerId);
    expect(page.items.map((item) => item.id)).toEqual(expected);

    // Guard the fixture itself: if these were not ties the assertion above
    // would be about `createdAt` and would tell us nothing about the tiebreak.
    const instants = new Set(page.items.map((item) => item.bookmarkedAt.toISOString()));
    expect(instants.size).toBe(1);
  });

  it('mints ids the id generator would accept', async () => {
    // The tiebreak is asserted against lexicographic order on `articleId`. That
    // is only meaningful if the fixture's ids are the same SHAPE as real ones —
    // a fixture using `1`, `2`, `10` would sort `10` before `2` and would have
    // been "proving" the tiebreak against a fiction.
    expect(articleIdFor(1)).toHaveLength(26);
    expect(isValidId(articleIdFor(1))).toBe(true);
    expect(isValidId(articleIdFor(21))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The cursor — the four properties DEC-032 names
// ---------------------------------------------------------------------------

describe('SPEC-011 — cursor pagination is total, terminating and non-repeating', () => {
  it('walks a tied page-boundary without repeating or dropping a row', async () => {
    // THE case this file was written for. Five bookmarks at one instant, walked
    // two at a time, so the boundary between page 1 and page 2 falls INSIDE the
    // tie. A cursor anchored on `createdAt` alone cannot resume here: every
    // remaining row compares equal to the anchor, so the query either returns
    // them all again or none of them.
    const expected = await seedTiedBookmarks(5);

    const walk = await walkAllPages(2);

    expect(walk.ids).toEqual(expected);
    expect(walk.ids).toHaveLength(new Set(walk.ids).size); // no repeats
    expect(walk.pages).toEqual([
      [expected[0], expected[1]],
      [expected[2], expected[3]],
      [expected[4]],
    ]);
  });

  it('agrees with the unpaginated query, row for row', async () => {
    // The strongest statement of the same property, and the one that would
    // survive a change to the sort: however the rows are ordered, walking them
    // two at a time must produce exactly the order a single large page does.
    const expected = await seedTiedBookmarks(7);

    const single = await listBookmarkedArticles(readerId, { take: 50 });
    const walk = await walkAllPages(2);

    expect(single.items.map((item) => item.id)).toEqual(expected);
    expect(walk.ids).toEqual(single.items.map((item) => item.id));
    expect(single.nextCursor).toBeNull();
  });

  it('returns nextCursor === null exactly on the last page, and not before', async () => {
    await seedTiedBookmarks(5);
    const walk = await walkAllPages(2);

    // Three pages: two full, one with the remainder. The cursor is non-null on
    // every page but the last, and null on the last — "exactly", so a
    // premature null (truncating the library) and a trailing non-null (an empty
    // final page the reader can scroll to) both fail.
    expect(walk.cursors).toHaveLength(3);
    expect(walk.cursors.slice(0, -1).every((cursor) => cursor !== null)).toBe(true);
    expect(walk.cursors[walk.cursors.length - 1]).toBeNull();
  });

  it('does not offer another page when the last page is exactly full', async () => {
    // The off-by-one. With exactly `take` rows the `take + 1` probe comes back
    // short, so `hasMore` is false and `nextCursor` must be null. The failure
    // mode this pins is the opposite reading — `rows.length >= take` — which
    // hands out a cursor to an empty page, and an infinite-scroll list that
    // never terminates.
    const expected = await seedTiedBookmarks(4);

    const page = await listBookmarkedArticles(readerId, { take: 4 });
    expect(page.items.map((item) => item.id)).toEqual(expected);
    expect(page.nextCursor).toBeNull();

    // One more than the page size: now there IS a next page, and it holds
    // exactly the one row that did not fit.
    const short = await listBookmarkedArticles(readerId, { take: 3 });
    expect(short.items).toHaveLength(3);
    expect(short.nextCursor).toBe(expected[2]);

    const rest = await listBookmarkedArticles(readerId, { cursor: short.nextCursor, take: 3 });
    expect(rest.items.map((item) => item.id)).toEqual([expected[3]]);
    expect(rest.nextCursor).toBeNull();
  });

  it('steps PAST the cursor row rather than repeating it', async () => {
    // `skip: 1`. Prisma includes the cursor row by default, so without it every
    // page begins with its predecessor's last row — a duplicate that looks like
    // a rendering glitch and is actually a lost row at the end of the list.
    const expected = await seedTiedBookmarks(6);
    const walk = await walkAllPages(2);

    for (let i = 1; i < walk.pages.length; i++) {
      const previous = walk.pages[i - 1] ?? [];
      const current = walk.pages[i] ?? [];
      expect(current[0]).not.toBe(previous[previous.length - 1]);
    }
    expect(walk.ids).toEqual(expected);
  });

  it('walks a mixed corpus — some ties, some distinct instants', async () => {
    // The shape the seed corpus actually has: a batch written at one fixed
    // instant alongside rows saved at different times. Neither the pure-tie
    // fixture nor a pure-distinct one exercises the transition between them,
    // which is where a tuple comparison built on the wrong column order breaks.
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      await makeArticle(i);
      // Articles 1-3 share one instant; 4, 5 and 6 each get their own, newer one.
      const at = i <= 3 ? tickFor(3) : tickFor(6 - i);
      await toggleBookmark(readerId, articleIdFor(i), at);
      ids.push(articleIdFor(i));
    }

    const single = await listBookmarkedArticles(readerId, { take: 50 });
    const walk = await walkAllPages(2);

    expect(walk.ids).toEqual(single.items.map((item) => item.id));
    expect(new Set(walk.ids)).toEqual(new Set(ids));
  });

  it('returns an empty page with a null cursor for a reader with no bookmarks', async () => {
    const page = await listBookmarkedArticles(readerId);
    expect(page.items).toEqual([]);
    // `hasMore && last` rather than `hasMore` alone: `last` is `T | undefined`
    // under `noUncheckedIndexedAccess`, and a cursor of `undefined` would
    // restart the list from the top instead of ending it.
    expect(page.nextCursor).toBeNull();
  });

  it('paginates one reader’s library without seeing another’s', async () => {
    await seedTiedBookmarks(3);
    for (let i = 1; i <= 3; i++) await toggleBookmark(otherReaderId, articleIdFor(i), SAME_TICK);

    const walk = await walkAllPages(2);
    expect(walk.ids).toHaveLength(3);

    const other = await listBookmarkedArticles(otherReaderId, { take: 50 });
    expect(other.items).toHaveLength(3);

    // A cursor is an articleId, and both readers have bookmarked the same
    // three articles. Handing one reader's cursor to the other must not leak a
    // row or change the count — the `userId` is part of the cursor's composite
    // key, so it cannot.
    const crossed = await listBookmarkedArticles(otherReaderId, {
      cursor: walk.cursors[0],
      take: 2,
    });
    expect(crossed.items.every((item) => item.id !== walk.pages[0]?.[0])).toBe(true);
  });

  it('defaults to SPEC-011’s page size of 20', async () => {
    expect(BOOKMARKS_PAGE_SIZE).toBe(20);

    // 21 rows, default `take`: the first page is 20 and there is a next one.
    // This is the only assertion in the file that exercises the real page size
    // rather than a narrowed one, and it is the number the spec fixes.
    const expected = await seedTiedBookmarks(21);

    const page = await listBookmarkedArticles(readerId);
    expect(page.items).toHaveLength(BOOKMARKS_PAGE_SIZE);
    expect(page.items.map((item) => item.id)).toEqual(expected.slice(0, BOOKMARKS_PAGE_SIZE));
    expect(page.nextCursor).toBe(expected[BOOKMARKS_PAGE_SIZE - 1]);

    const last = await listBookmarkedArticles(readerId, { cursor: page.nextCursor });
    expect(last.items.map((item) => item.id)).toEqual([expected[BOOKMARKS_PAGE_SIZE]]);
    expect(last.nextCursor).toBeNull();
  });
});
