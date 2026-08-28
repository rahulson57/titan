/**
 * Feed pagination cursors (SPEC-008).
 *
 * > Cursor-based, never `OFFSET`. Cursor is the opaque base64 of
 * > `{ score, publishedAt, id }` for the last row; page size **20**. A cursor
 * > is stable across a page-2 request even if new articles are published in
 * > between (no duplicates, no skips within a paging session).
 *
 * ── Why the payload carries a fourth field ────────────────────────────────
 * The spec's own two sentences pull against each other, and the fourth field
 * is what reconciles them rather than a liberty taken with the first.
 *
 * `score` is a function of TIME: `2.0 * exp(-ageHours/72)` shrinks as the
 * clock advances, and it shrinks at DIFFERENT rates for articles of different
 * ages. So the ranked order is not merely all-scores-slightly-lower a minute
 * later — pairs genuinely swap. Concretely: an old, well-clapped article and a
 * fresh, lightly-clapped one can be in either order depending on when you ask.
 *
 * Now put a three-field cursor against that. Page 1 is taken at t1 and the
 * cursor records the last row's score AS OF t1. Page 2 arrives at t2 and
 * recomputes every score against t2. A row that sat above the cursor at t1 can
 * score below it at t2 — so it is served again on page 2, having already
 * appeared on page 1. The mirror case skips a row entirely. That is precisely
 * the "no duplicates, no skips within a paging session" the same paragraph
 * forbids, and no amount of care in the query fixes it: the two pages were
 * ordered by two different functions.
 *
 * Recording the paging session's clock IN the cursor pins the whole session to
 * one ordering function, which makes the guarantee true instead of aspirational.
 * The spec's `{ score, publishedAt, id }` is preserved exactly — it is the row
 * anchor, and it is still what identifies the last row. `now` is not part of
 * the anchor; it is the clock the anchor was measured against, and shipping an
 * anchor without its clock is like shipping a measurement without its units.
 *
 * It also delivers the stability clause's stated case for free: an article
 * published BETWEEN page 1 and page 2 has a negative age against the frozen
 * clock, scores above everything real, sorts above the cursor, and is
 * therefore excluded from page 2 — it will be there on the reader's next
 * visit, at the top, which is where a just-published article belongs.
 *
 * The alternative — make callers thread `now` through every page request as a
 * separate URL parameter — keeps the payload literal and moves the failure
 * mode somewhere worse: one caller that forgets it silently reintroduces the
 * duplicate-row bug, and nothing in the type system notices. Here the cursor
 * is one opaque token that cannot be split from its clock.
 *
 * ── Why decoding never throws ─────────────────────────────────────────────
 * A cursor arrives in the query string, so it is attacker-controlled and, far
 * more often, just stale — a bookmarked page-3 link, or a token truncated by a
 * mail client. `decodeCursor` answers `null` for anything it cannot read, and
 * the surfaces treat `null` as "start from the beginning". A 500 on a mangled
 * URL parameter would be a worse answer than the first page.
 */

import type { Ranked } from './rank';

/**
 * The decoded cursor.
 *
 * Instants are carried as ISO strings rather than epoch numbers because the
 * payload is JSON that a developer will read while debugging, and
 * `"2026-03-01T12:00:00.000Z"` is self-describing where `1772366400000` is
 * not. Both round-trip exactly; ISO-8601 with milliseconds loses nothing a
 * `Date` holds.
 */
export interface FeedCursor {
  /** The last row's score, as of `now`. */
  score: number;
  /** The last row's `publishedAt`, ISO-8601. */
  publishedAt: string;
  /** The last row's id — the final tiebreak. */
  id: string;
  /** The clock the whole paging session is ordered against, ISO-8601. */
  now: string;
}

/** The row shape a cursor is built from: anything `rank.ts` has scored. */
export type CursorAnchor = Pick<Ranked, 'score' | 'publishedAt' | 'id'>;

/**
 * Base64url, not plain base64.
 *
 * The token travels in a query string. Plain base64's `+` and `/` are `space`
 * and a path separator once a URL is parsed, and `=` padding invites
 * over-eager encoders to mangle it. base64url is the same bytes with a URL-safe
 * alphabet, so the cursor survives being copied, shared and re-parsed.
 */
function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/** Build the opaque cursor for the last row of a page. */
export function encodeCursor(row: CursorAnchor, now: Date): string {
  const payload: FeedCursor = {
    score: row.score,
    publishedAt: row.publishedAt.toISOString(),
    id: row.id,
    now: now.toISOString(),
  };
  return encodeBase64Url(JSON.stringify(payload));
}

/** True for a finite number — rejects `NaN`, `Infinity` and non-numbers. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True for a string that `Date` parses to a real instant. */
function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Read a cursor back, or `null` if it is anything other than a cursor this
 * module wrote.
 *
 * Every field is validated, not just parsed. A payload of `{"score":"top"}`
 * decodes as JSON perfectly well and would otherwise poison every comparison
 * downstream with `NaN`, which sorts as "not greater and not less than
 * anything" and quietly produces a feed in an undefined order. Rejecting it
 * here means one malformed cursor costs the reader the first page instead of a
 * scrambled one.
 */
export function decodeCursor(token: string | null | undefined): FeedCursor | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(token));
  } catch {
    return null; // not base64url, or not JSON
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (!isFiniteNumber(candidate.score)) return null;
  if (!isInstant(candidate.publishedAt)) return null;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (!isInstant(candidate.now)) return null;

  return {
    score: candidate.score,
    publishedAt: candidate.publishedAt,
    id: candidate.id,
    now: candidate.now,
  };
}

/**
 * The clock a request should rank against: the paging session's, if this is a
 * continuation, otherwise the one supplied.
 *
 * This is the single line that makes a paging session coherent, so it is a
 * named function rather than a `??` buried in the query module — a caller that
 * forgets it does not get a subtly wrong feed, it gets a compile error at a
 * missing argument.
 */
export function clockFor(cursor: FeedCursor | null, fallback: Date): Date {
  return cursor ? new Date(cursor.now) : fallback;
}

/**
 * Does `row` sort strictly AFTER `cursor` in SPEC-008's total order?
 *
 * The comparison chain is `compareRanked`'s, restated against the cursor's
 * decoded fields rather than reusing it, because a cursor is not a row: it
 * has no `clapTotal` and manufacturing a fake one to satisfy the type would
 * be a lie that a future edit could start believing.
 *
 * Strictness is the whole point. `>=` here would serve the cursor row itself
 * as the first item of the next page — the classic off-by-one that shows up as
 * "the last story on every page is the first story on the next one".
 */
export function sortsAfterCursor(row: CursorAnchor, cursor: FeedCursor): boolean {
  if (row.score !== cursor.score) return row.score < cursor.score;

  const rowAt = row.publishedAt.getTime();
  const cursorAt = Date.parse(cursor.publishedAt);
  if (rowAt !== cursorAt) return rowAt < cursorAt;

  return row.id > cursor.id;
}
