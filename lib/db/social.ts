/**
 * The social-graph repository: Clap, Bookmark, Follow (SPEC-004).
 *
 * Consumed as `EngagementRepo` by Reading & Engagement (SPEC-009). Three
 * invariants live here because the database cannot hold them:
 *
 *  1. **Clap count is 1..50 per (user, article).** SQLite has no CHECK that
 *     Prisma will emit, so the bound is enforced on write and
 *     `tests/unit/repo-clap.test.ts` proves both ends of it. The composite
 *     primary key does the rest: a second clap by the same reader UPDATES the
 *     one row rather than inserting a second.
 *  2. **`followerId != followingId`.** Rejected with `SelfFollowError`, which
 *     SPEC-009 maps to a 400.
 *  3. **`clapTotal` and `followerCount` are never stored.** They are read-time
 *     aggregates (SPEC-004). A denormalised counter would be a second source of
 *     truth that drifts the first time a cascade deletes rows out from under
 *     it — and a user deletion cascades a lot of rows.
 */

import type { Bookmark, Clap, Follow } from '@prisma/client';
import { getDb } from './client';

export type { Bookmark, Clap, Follow };

/** SPEC-004 / SPEC-009: a reader may contribute at most 50 claps per article. */
export const MAX_CLAPS_PER_READER = 50;
export const MIN_CLAPS_PER_READER = 1;

export class ClapCountError extends Error {
  constructor(count: number) {
    super(
      `clap count must be between ${MIN_CLAPS_PER_READER} and ${MAX_CLAPS_PER_READER}, got ${count}`,
    );
    this.name = 'ClapCountError';
  }
}

export class SelfFollowError extends Error {
  constructor(userId: string) {
    super(`user ${userId} cannot follow themselves`);
    this.name = 'SelfFollowError';
  }
}

// ---------------------------------------------------------------------------
// Claps
// ---------------------------------------------------------------------------

/**
 * Set a reader's clap count on an article to an exact value.
 *
 * Rejects anything outside 1..50 rather than clamping, because "set it to 80"
 * is a caller bug and silently storing 50 would hide it.
 * `incrementClap` is the forgiving path SPEC-009's action actually uses.
 */
export async function setClap(
  userId: string,
  articleId: string,
  count: number,
  now: Date = new Date(),
): Promise<Clap> {
  if (!Number.isInteger(count) || count < MIN_CLAPS_PER_READER || count > MAX_CLAPS_PER_READER) {
    throw new ClapCountError(count);
  }
  return getDb().clap.upsert({
    where: { userId_articleId: { userId, articleId } },
    update: { count },
    create: { userId, articleId, count, createdAt: now },
  });
}

/**
 * Add claps, saturating at the ceiling.
 *
 * SPEC-009: "Beyond 50 it is a no-op returning the existing total, not an
 * error." That asymmetry with `setClap` is deliberate — a reader hammering the
 * clap button past 50 has done nothing wrong, whereas a caller passing 80 to
 * `setClap` has.
 */
export async function incrementClap(
  userId: string,
  articleId: string,
  by = 1,
  now: Date = new Date(),
): Promise<Clap> {
  // NOTE (flagged to TASK-009, not changed here): with no existing row, `by <= 0`
  // floors up to MIN_CLAPS_PER_READER and CREATES a 1-clap row — a call meaning
  // "add nothing" registers a clap. That is deliberate as it stands: the test
  // "treats a nonsense increment as at least one clap, never zero rows" pins it,
  // and clap interaction semantics are SPEC-009's, not SPEC-004's. SPEC-004 only
  // requires count ∈ 1..50 and one row per (user, article), both of which hold
  // either way. Left as-is rather than reversed inside this slice.
  const existing = await getDb().clap.findUnique({
    where: { userId_articleId: { userId, articleId } },
  });
  const next = Math.min(MAX_CLAPS_PER_READER, (existing?.count ?? 0) + Math.max(0, by));
  return setClap(userId, articleId, Math.max(MIN_CLAPS_PER_READER, next), now);
}

/** `SUM(count) WHERE articleId = ?` — computed, never stored. */
export async function getClapTotal(articleId: string): Promise<number> {
  const result = await getDb().clap.aggregate({
    where: { articleId },
    _sum: { count: true },
  });
  return result._sum.count ?? 0;
}

/** This reader's own contribution, for rendering the control's filled state. */
export async function getClapByReader(userId: string, articleId: string): Promise<number> {
  const row = await getDb().clap.findUnique({
    where: { userId_articleId: { userId, articleId } },
  });
  return row?.count ?? 0;
}

export async function countClapRows(articleId: string): Promise<number> {
  return getDb().clap.count({ where: { articleId } });
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export async function isBookmarked(userId: string, articleId: string): Promise<boolean> {
  const row = await getDb().bookmark.findUnique({
    where: { userId_articleId: { userId, articleId } },
  });
  return row !== null;
}

/**
 * Idempotent toggle (SPEC-009). Returns the resulting state, not the previous
 * one, so an optimistic UI can roll back to exactly what the server holds.
 */
export async function toggleBookmark(
  userId: string,
  articleId: string,
  now: Date = new Date(),
): Promise<{ bookmarked: boolean }> {
  if (await isBookmarked(userId, articleId)) {
    await getDb().bookmark.delete({ where: { userId_articleId: { userId, articleId } } });
    return { bookmarked: false };
  }
  await getDb().bookmark.create({ data: { userId, articleId, createdAt: now } });
  return { bookmarked: true };
}

/** Explicit removal — the inline un-bookmark control on `/bookmarks`. */
export async function removeBookmark(userId: string, articleId: string): Promise<void> {
  await getDb().bookmark.deleteMany({ where: { userId, articleId } });
}

export async function countBookmarks(userId: string): Promise<number> {
  return getDb().bookmark.count({ where: { userId } });
}

/**
 * One row of `/bookmarks` (SPEC-011), projected to exactly what the list needs.
 *
 * Deliberately NOT the whole `Article`. `bodyJson` and `bodyHtml` are the two
 * largest columns in the schema and a page of 20 rows would carry both across
 * the server/client boundary for no reason — the list renders a title, a
 * byline, an excerpt and some tags. `bodyText` is included because the excerpt
 * is derived from it; the parsed ProseMirror document is not, because nothing
 * on this surface renders the body.
 *
 * `bookmarkedAt` is the join row's `createdAt`, kept distinct from the
 * article's own dates. They mean different things — when the reader saved it
 * versus when the author published it — and collapsing them into one field is
 * how a byline ends up showing the wrong date.
 */
export interface BookmarkedArticle {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  bodyText: string;
  coverPath: string | null;
  readingMinutes: number;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  author: { name: string; handle: string; avatarPath: string | null };
  tags: { slug: string; name: string }[];
  /** `Bookmark.createdAt` — the sort key, and the cursor's anchor. */
  bookmarkedAt: Date;
}

export interface ListBookmarksOptions {
  /** The `articleId` of the last row on the previous page. */
  cursor?: string | null;
  /** SPEC-011 fixes the page size at 20; callers may narrow it for tests. */
  take?: number;
}

export interface BookmarkPage {
  items: BookmarkedArticle[];
  /** Pass as the next call's `cursor`. `null` when this is the last page. */
  nextCursor: string | null;
}

/** SPEC-011: "cursor-paginated at page size 20". */
export const BOOKMARKS_PAGE_SIZE = 20;

/**
 * A reader's bookmarks, newest save first, cursor-paginated (SPEC-011).
 *
 * > "Reverse-chronological by `Bookmark.createdAt`, cursor-paginated at page
 * >  size 20."
 *
 * ── Why a cursor and not an offset ────────────────────────────────────────
 * The schema is built for it: `Bookmark` carries
 * `@@index([userId, createdAt(sort: Desc)])`, which this query walks directly.
 * Offset pagination would also run, and would be wrong for a list the reader
 * is actively mutating — un-bookmarking one row on page 1 shifts every later
 * page up by one, so `skip: 20` silently steps over a row the reader has never
 * seen. A cursor is anchored to a row, so it cannot slip underneath them.
 *
 * ── Why the sort is a PAIR of columns ─────────────────────────────────────
 * `createdAt DESC, articleId DESC`, not `createdAt` alone. `Bookmark.createdAt`
 * is not unique: a reader saving two articles in the same tick produces a tie,
 * and so does any seed that writes a batch at one fixed instant — which
 * SPEC-002's 500-article corpus does by construction, since determinism
 * requires a fixed clock. A cursor over a non-total order can repeat rows or
 * skip them, and the failure only appears once the data has ties, which is to
 * say in front of a user rather than in a three-row fixture. The composite
 * primary key `(userId, articleId)` supplies the tiebreak, so the order is
 * total.
 *
 * ── The extra row ─────────────────────────────────────────────────────────
 * `take + 1` fetches one row past the page purely to answer "is there another
 * page?", then drops it. The alternative is a second `COUNT(*)` over a set
 * that only grows, to learn one bit. Returning `nextCursor` rather than a
 * boolean means the caller never has to know how the cursor is derived.
 *
 * `skip: 1` steps past the cursor row itself, which Prisma includes by
 * default — without it every page repeats its predecessor's last row.
 *
 * ── On DRAFT rows ─────────────────────────────────────────────────────────
 * No status filter, deliberately. A bookmark can only be created from a
 * readable article, and if an author later unpublishes something a reader
 * saved, that reader keeps the row — the article page itself is what enforces
 * SPEC-005's draft-privacy rule (404 for a non-author), so the link goes
 * nowhere for anyone who may not read it. Filtering here would instead make
 * saved items silently vanish from a personal library, which is a worse and
 * more confusing answer than a link that has stopped working. `status` is
 * returned so a caller that wants to mark such a row can.
 */
export async function listBookmarkedArticles(
  userId: string,
  options: ListBookmarksOptions = {},
): Promise<BookmarkPage> {
  const take = options.take ?? BOOKMARKS_PAGE_SIZE;
  const cursor = options.cursor ?? null;

  const rows = await getDb().bookmark.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { articleId: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { userId_articleId: { userId, articleId: cursor } }, skip: 1 } : {}),
    include: {
      article: {
        select: {
          id: true,
          slug: true,
          title: true,
          subtitle: true,
          bodyText: true,
          coverPath: true,
          readingMinutes: true,
          status: true,
          publishedAt: true,
          createdAt: true,
          author: { select: { name: true, handle: true, avatarPath: true } },
          tags: { select: { tag: { select: { slug: true, name: true } } } },
        },
      },
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(({ article, createdAt }) => ({
      id: article.id,
      slug: article.slug,
      title: article.title,
      subtitle: article.subtitle,
      bodyText: article.bodyText,
      coverPath: article.coverPath,
      readingMinutes: article.readingMinutes,
      status: article.status,
      publishedAt: article.publishedAt,
      createdAt: article.createdAt,
      author: article.author,
      tags: article.tags.map(({ tag }) => tag),
      bookmarkedAt: createdAt,
    })),
    // `hasMore && last` rather than `hasMore` alone: `last` is `T | undefined`
    // under `noUncheckedIndexedAccess`, and a cursor of `undefined` would
    // silently restart the list from the top instead of ending it.
    nextCursor: hasMore && last ? last.articleId : null,
  };
}

// ---------------------------------------------------------------------------
// Follows
// ---------------------------------------------------------------------------

export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const row = await getDb().follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });
  return row !== null;
}

export async function follow(
  followerId: string,
  followingId: string,
  now: Date = new Date(),
): Promise<Follow> {
  if (followerId === followingId) throw new SelfFollowError(followerId);
  return getDb().follow.upsert({
    where: { followerId_followingId: { followerId, followingId } },
    update: {},
    create: { followerId, followingId, createdAt: now },
  });
}

export async function unfollow(followerId: string, followingId: string): Promise<void> {
  await getDb().follow.deleteMany({ where: { followerId, followingId } });
}

/**
 * Idempotent toggle (SPEC-009). Self-follow throws before anything is written,
 * so a mistaken call cannot leave a row behind on the "off" half of a toggle.
 */
export async function toggleFollow(
  followerId: string,
  followingId: string,
  now: Date = new Date(),
): Promise<{ following: boolean; followerCount: number }> {
  if (followerId === followingId) throw new SelfFollowError(followerId);

  if (await isFollowing(followerId, followingId)) {
    await unfollow(followerId, followingId);
    return { following: false, followerCount: await getFollowerCount(followingId) };
  }
  await follow(followerId, followingId, now);
  return { following: true, followerCount: await getFollowerCount(followingId) };
}

/** `COUNT(*) WHERE followingId = ?` — computed, never stored. */
export async function getFollowerCount(userId: string): Promise<number> {
  return getDb().follow.count({ where: { followingId: userId } });
}

export async function getFollowingCount(userId: string): Promise<number> {
  return getDb().follow.count({ where: { followerId: userId } });
}

/** The author ids whose articles fill the viewer's Following timeline. */
export async function listFollowingIds(followerId: string): Promise<string[]> {
  const rows = await getDb().follow.findMany({
    where: { followerId },
    select: { followingId: true },
    orderBy: { followingId: 'asc' },
  });
  return rows.map((row) => row.followingId);
}
