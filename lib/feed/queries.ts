/**
 * The query shapes behind the discovery surfaces (SPEC-008).
 *
 * > Reads go through `lib/db/` repositories; this module owns the query
 * > shapes.
 *
 * Three surfaces, one order, one cursor:
 *
 *   | function             | surface        | order                              |
 *   |----------------------|----------------|------------------------------------|
 *   | `getFeedPage`        | `/` For you    | SPEC-008's score DESC, then ties    |
 *   | `getFollowingPage`   | `/` Following  | `publishedAt DESC, id ASC`          |
 *   | `getTagPage`         | `/tag/[slug]`  | `publishedAt DESC, id ASC`          |
 *
 * The last two are `rank.ts`'s `chronological` — the same total order with
 * every score pinned to zero — so all three share one cursor implementation
 * and one place a paging bug can live.
 *
 * ── The connection, and the boundary rule ─────────────────────────────────
 * SPEC-004 forbids any module outside `lib/db/**` from importing the generated
 * Prisma client package, and `tests/unit/db-boundary.test.ts` enforces it by
 * SUBSTRING over the source — so this comment cannot spell the specifier
 * either, and that is not a quirk to route around: a file that names it in
 * prose today is a file someone imports from tomorrow.
 *
 * This module imports `getDb` FROM `lib/db/client.ts` and never names the
 * package, so it reads through the one app connection — with
 * `foreign_keys=ON`, `busy_timeout` and the single-connection pool already
 * established — exactly as the rule intends.
 * The repository modules own the entities; SPEC-008 hands this module the
 * query shapes, which is why the feed's projections live here rather than as
 * five more exports on `lib/db/articles.ts`.
 *
 * ── Why every path is two or three statements and never more ──────────────
 * SPEC-002 budgets the feed query at p95 < 50ms over 100 runs on the
 * 500-article corpus, and states outright what that budget is hunting: an N+1,
 * "one query per article for its author or clap count". So the shape here is
 * fixed — a projection, an aggregate over the whole page at once, and a
 * hydration restricted to the page's ids. Nothing in this file loops over
 * articles issuing queries, and `hydrateRanked()` exists so that no future surface
 * has to reinvent that discipline.
 */

import { getDb } from '../db/client';
import { decodeCursor, clockFor, encodeCursor, sortsAfterCursor, type FeedCursor } from './cursor';
import { FEED_PAGE_SIZE, chronological, rankArticles } from './rank';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** SPEC-008: "Two tabs: **For you** (default, anonymous-safe) and **Following**". */
export const FEED_TABS = ['for-you', 'following'] as const;
export type FeedTab = (typeof FEED_TABS)[number];

/** The default tab. Anonymous-safe, per the spec's own parenthetical. */
export const DEFAULT_FEED_TAB: FeedTab = 'for-you';

/**
 * Read a tab out of a query string.
 *
 * Anything unrecognised falls back to the default rather than 404ing: `?tab=`
 * is a hint from a link, not an identifier, and a typo in a shared URL should
 * land the reader on the feed rather than on an error page.
 */
export function parseFeedTab(value: string | null | undefined): FeedTab {
  return FEED_TABS.includes(value as FeedTab) ? (value as FeedTab) : DEFAULT_FEED_TAB;
}

export interface FeedAuthor {
  name: string;
  handle: string;
  avatarPath: string | null;
}

export interface FeedTagRef {
  slug: string;
  name: string;
}

/**
 * One card's worth of article.
 *
 * Deliberately NOT the whole row, for the reason `lib/db/social.ts` gives at
 * greater length: `bodyJson` and `bodyHtml` are the two largest columns in the
 * schema, a page carries twenty of them, and no discovery surface renders a
 * body. `bodyText` is here because the excerpt is cut from it.
 *
 * `score` and `cursor` are carried per item rather than returned alongside the
 * page. That is what lets `getFeedPage` return a plain array — the shape
 * `tests/perf/feed-query.test.ts` already declares — while still handing the
 * caller everything it needs to ask for the next page.
 */
export interface FeedItem {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  bodyText: string;
  coverPath: string | null;
  readingMinutes: number;
  publishedAt: Date;
  author: FeedAuthor;
  tags: FeedTagRef[];
  /** `SUM(Clap.count)` — SPEC-004 never stores this, so it is computed. */
  clapTotal: number;
  /** How many readers have saved it. */
  bookmarkCount: number;
  /** SPEC-008's score under the clock this page was ranked against. */
  score: number;
  /** Opaque token that asks for the page after THIS row. */
  cursor: string;
  /**
   * Set only by `searchArticles` — the bm25-selected excerpt around the
   * match. Feed surfaces leave it undefined and cut their own excerpt.
   */
  snippet?: string;
}

/** Options every paged surface accepts. */
export interface FeedPageOptions {
  /** Page size. Defaults to SPEC-008's 20. */
  limit?: number;
  /** The opaque token from the previous page, or null/undefined for page 1. */
  cursor?: string | null;
  /**
   * The clock the score is evaluated against (SPEC-008: "injected as a
   * parameter so tests are deterministic").
   *
   * Ignored when `cursor` is present — a continuation is ranked against the
   * clock the paging session started with, which is what makes the session
   * free of duplicates and skips. See `lib/feed/cursor.ts`.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The columns every card needs, in one place so the three surfaces agree. */
const CARD_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  bodyText: true,
  coverPath: true,
  readingMinutes: true,
  publishedAt: true,
  author: { select: { name: true, handle: true, avatarPath: true } },
  tags: { select: { tag: { select: { slug: true, name: true } } } },
  _count: { select: { bookmarks: true } },
} as const;

/**
 * SPEC-008: "Only `status = 'PUBLISHED'` rows ever appear in any feed, tag
 * page, or search result."
 *
 * One constant, used by every query in this file, so the visibility rule
 * cannot be present on two surfaces and forgotten on the third. `publishedAt`
 * is required as well as the status: a row claiming PUBLISHED with no
 * publication instant has no age and therefore no score (see `rank.ts`), and
 * silently ranking it would hide the data defect.
 */
const PUBLISHED_ONLY = { status: 'PUBLISHED', publishedAt: { not: null } } as const;

/**
 * The minimum `hydrateRanked` needs: which row, and where it sorted.
 *
 * Narrower than `Ranked` on purpose. `lib/search/fts.ts` orders by bm25 and
 * has no clap total and no publication instant in hand at that point;
 * requiring the full `Rankable` there would have meant fabricating two fields
 * that hydration is about to read from the database anyway.
 */
export interface HydrationEntry {
  id: string;
  /** Position in whatever order the caller established. Larger sorts first. */
  score: number;
}

/** `SUM(Clap.count)` for a set of articles — ONE statement, never per row. */
async function clapTotalsFor(articleIds: readonly string[]): Promise<Map<string, number>> {
  if (articleIds.length === 0) return new Map();

  const grouped = await getDb().clap.groupBy({
    by: ['articleId'],
    where: { articleId: { in: [...articleIds] } },
    _sum: { count: true },
  });

  return new Map(grouped.map((row) => [row.articleId, row._sum.count ?? 0]));
}

/**
 * Turn a page's worth of ids into cards, preserving the ORDER THEY ARRIVED IN.
 *
 * Exported because `lib/search/fts.ts` hydrates a bm25-ordered page the same
 * way. One hydration path means the search results and the feed carry
 * identical cards, and a column added for one surface cannot be missing on
 * the other.
 *
 * `WHERE id IN (...)` returns rows in whatever order the engine finds them,
 * which is not the ranked order and is not stable between runs. Re-sorting
 * here from the id list rather than trusting the query is the difference
 * between a feed that is ranked and a feed that merely contains the right
 * twenty articles.
 */
export async function hydrateRanked(
  ranked: readonly HydrationEntry[],
  now: Date,
): Promise<FeedItem[]> {
  if (ranked.length === 0) return [];

  const ids = ranked.map((row) => row.id);
  const [rows, clapTotals] = await Promise.all([
    getDb().article.findMany({ where: { id: { in: ids } }, select: CARD_SELECT }),
    clapTotalsFor(ids),
  ]);

  const byId = new Map(rows.map((row) => [row.id, row]));

  const items: FeedItem[] = [];
  for (const entry of ranked) {
    const row = byId.get(entry.id);
    // An id that vanished between the projection and the hydration — the
    // author deleted the article mid-page. Dropping it is right; a card with
    // no data behind it is worse than a page of nineteen.
    if (!row || row.publishedAt === null) continue;

    items.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      bodyText: row.bodyText,
      coverPath: row.coverPath,
      readingMinutes: row.readingMinutes,
      publishedAt: row.publishedAt,
      author: row.author,
      tags: row.tags.map(({ tag }) => tag),
      clapTotal: clapTotals.get(row.id) ?? 0,
      bookmarkCount: row._count.bookmarks,
      score: entry.score,
      // Built from the HYDRATED row's own `publishedAt`, not from anything
      // the caller supplied. The cursor is the row's position in the total
      // order, so it has to be the row's real instant — a caller that passed
      // an approximation would mint a cursor that points at a place in the
      // ordering where no row lives.
      cursor: encodeCursor({ score: entry.score, publishedAt: row.publishedAt, id: row.id }, now),
    });
  }
  return items;
}

/**
 * The keyset predicate for the two reverse-chronological surfaces.
 *
 * `publishedAt < cursor OR (publishedAt = cursor AND id > cursorId)` is
 * `compareRanked`'s tail, expressed where SQLite can use the
 * `(status, publishedAt DESC)` index rather than reading the whole table into
 * the process to throw most of it away. The ranked feed cannot do this — its
 * sort key is not a column — which is exactly why it takes the other route.
 */
function chronologicalCursorFilter(cursor: FeedCursor | null) {
  if (!cursor) return {};
  const at = new Date(cursor.publishedAt);
  return {
    OR: [
      { publishedAt: { lt: at } },
      { AND: [{ publishedAt: at }, { id: { gt: cursor.id } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// For you
// ---------------------------------------------------------------------------

/**
 * The ranked home feed (SPEC-008's "For you").
 *
 * ── Why this reads every published row before taking twenty ───────────────
 * The sort key is a function of the clock, so it is not a column and cannot be
 * an index. `ORDER BY score LIMIT 20` in SQL is unavailable anyway — SQLite as
 * shipped inside Prisma has no `ln`/`exp` (measured; see `rank.ts`) — so the
 * choice is between ranking the candidate set in this process and not ranking
 * at all.
 *
 * What that costs is bounded and small, and the shape is what keeps it so: the
 * projection reads TWO columns per published article and the clap totals in
 * one aggregate, then exactly twenty full rows are hydrated. On SPEC-002's
 * 500-article corpus that is ~500 id/date pairs — hundreds of microseconds of
 * SQLite work and a sort of 500 elements — against a 50ms budget, and
 * `tests/perf/feed-query.test.ts` holds it there over 100 runs. The thing the
 * budget is actually hunting, an N+1 over authors or clap counts, is absent by
 * construction here.
 *
 * If this corpus ever became large enough for that scan to matter, the answer
 * is a materialised score column maintained on write, not a cleverer query —
 * but writing that now would be inventing a scaling story SPEC-008 explicitly
 * declines to have ("there is no behavioural data on a 50-user seed corpus").
 */
export async function getFeedPage(options: FeedPageOptions = {}): Promise<FeedItem[]> {
  const limit = options.limit ?? FEED_PAGE_SIZE;
  const cursor = decodeCursor(options.cursor);
  const now = clockFor(cursor, options.now ?? new Date());

  const [candidates, clapTotals] = await Promise.all([
    getDb().article.findMany({
      where: PUBLISHED_ONLY,
      select: { id: true, publishedAt: true },
    }),
    // Every clap row in the database, summed per article, in one statement.
    // Scoped to nothing because the ranking needs a total for every candidate;
    // narrowing it to the page's ids is impossible, since which ids are on the
    // page is what the totals decide.
    getDb().clap.groupBy({ by: ['articleId'], _sum: { count: true } }),
  ]);

  const totals = new Map(clapTotals.map((row) => [row.articleId, row._sum.count ?? 0]));

  const ranked = rankArticles(
    candidates.flatMap((row) =>
      // `publishedAt: { not: null }` already excluded these; the guard is here
      // to narrow the nullable column for the type system rather than to
      // change behaviour.
      row.publishedAt === null
        ? []
        : [{ id: row.id, publishedAt: row.publishedAt, clapTotal: totals.get(row.id) ?? 0 }],
    ),
    now,
  );

  const page = (cursor ? ranked.filter((row) => sortsAfterCursor(row, cursor)) : ranked).slice(
    0,
    limit,
  );

  return hydrateRanked(page, now);
}

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

export interface FollowingPageOptions extends FeedPageOptions {
  /** The signed-in reader, or null for an anonymous visitor. */
  viewerId: string | null | undefined;
}

/**
 * SPEC-008: "a pure reverse-chronological list of articles by authors the
 * viewer follows; no scoring."
 *
 * An anonymous viewer follows nobody, so the answer is an empty page — and it
 * is answered WITHOUT a query. That is not an optimisation: `viewerId` of
 * `null` reaching the `where` clause would build
 * `followers: { some: { followerId: null } }`, and a relation filter on a null
 * scalar is the kind of predicate that matches everything in one ORM version
 * and nothing in the next. Returning early makes the anonymous case a property
 * of this function rather than of Prisma's null semantics.
 */
export async function getFollowingPage(options: FollowingPageOptions): Promise<FeedItem[]> {
  const viewerId = options.viewerId;
  if (!viewerId) return [];

  const limit = options.limit ?? FEED_PAGE_SIZE;
  const cursor = decodeCursor(options.cursor);
  const now = clockFor(cursor, options.now ?? new Date());

  const rows = await getDb().article.findMany({
    where: {
      ...PUBLISHED_ONLY,
      // `User.followers` is the `FollowingToUser` side: rows whose
      // `followingId` is this author. So "some follower row whose followerId
      // is the viewer" reads as "the viewer follows this author".
      author: { followers: { some: { followerId: viewerId } } },
      ...chronologicalCursorFilter(cursor),
    },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, publishedAt: true },
  });

  return hydrateRanked(
    chronological(
      rows.flatMap((row) =>
        row.publishedAt === null ? [] : [{ id: row.id, publishedAt: row.publishedAt, clapTotal: 0 }],
      ),
    ),
    now,
  );
}

// ---------------------------------------------------------------------------
// Tag pages
// ---------------------------------------------------------------------------

export interface TagPageOptions extends FeedPageOptions {
  /** The tag's slug, already normalised by `lib/db/tags.ts`. */
  slug: string;
}

/** SPEC-008: "Published articles with that tag, newest first". */
export async function getTagPage(options: TagPageOptions): Promise<FeedItem[]> {
  const limit = options.limit ?? FEED_PAGE_SIZE;
  const cursor = decodeCursor(options.cursor);
  const now = clockFor(cursor, options.now ?? new Date());

  const rows = await getDb().article.findMany({
    where: {
      ...PUBLISHED_ONLY,
      tags: { some: { tag: { slug: options.slug } } },
      ...chronologicalCursorFilter(cursor),
    },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, publishedAt: true },
  });

  return hydrateRanked(
    chronological(
      rows.flatMap((row) =>
        row.publishedAt === null ? [] : [{ id: row.id, publishedAt: row.publishedAt, clapTotal: 0 }],
      ),
    ),
    now,
  );
}

// ---------------------------------------------------------------------------
// Popular tags
// ---------------------------------------------------------------------------

export interface PopularTag extends FeedTagRef {
  /** How many PUBLISHED articles carry the tag. */
  articleCount: number;
}

/** SPEC-008's search empty state shows "5 popular tags". */
export const POPULAR_TAGS_LIMIT = 5;

/**
 * The most-used tags, counted over PUBLISHED articles only.
 *
 * Counting the join table directly rather than reading `Tag._count.articles`
 * is the difference between "tags on published work" and "tags on anything
 * anyone ever drafted". The second would let an author's private drafts steer
 * a public affordance — not a draft LEAK, since no article is named, but it
 * would still be private activity moving something a stranger sees.
 *
 * Ties break on `tagId` so the row set is deterministic; SPEC-002 forbids a
 * test whose expected value depends on which of two equal counts the engine
 * happened to return first.
 */
export async function getPopularTags(limit: number = POPULAR_TAGS_LIMIT): Promise<PopularTag[]> {
  const grouped = await getDb().articleTag.groupBy({
    by: ['tagId'],
    where: { article: PUBLISHED_ONLY },
    _count: { articleId: true },
    orderBy: [{ _count: { articleId: 'desc' } }, { tagId: 'asc' }],
    take: limit,
  });
  if (grouped.length === 0) return [];

  const tags = await getDb().tag.findMany({
    where: { id: { in: grouped.map((row) => row.tagId) } },
    select: { id: true, slug: true, name: true },
  });
  const byId = new Map(tags.map((tag) => [tag.id, tag]));

  return grouped.flatMap((row) => {
    const tag = byId.get(row.tagId);
    return tag ? [{ slug: tag.slug, name: tag.name, articleCount: row._count.articleId }] : [];
  });
}
