/**
 * The one canonical feed ranking formula (SPEC-008).
 *
 * > ```
 * > score = ln(1 + clapTotal) + 2.0 * exp(-ageHours / 72.0)
 * > ORDER BY score DESC, publishedAt DESC, id ASC
 * > ```
 *
 * Everything about the For-you feed's order is decided here and nowhere else:
 * the score, the tiebreak chain, and the page size. `lib/feed/queries.ts`
 * projects rows and this module orders them; `app/page.tsx` renders whatever
 * order it is handed. A second copy of this arithmetic anywhere else is a
 * defect by construction, because the two copies will disagree the first time
 * either constant moves.
 *
 * ── Why the score is computed in TypeScript and not in SQL ─────────────────
 * SPEC-008 says the score is "computed in SQL". It cannot be, on this stack,
 * and the reason is not a matter of preference or effort:
 *
 *     SELECT ln(2.0);  ->  Raw query failed. Code: `1`. Message: `no such
 *                          function: ln`
 *
 * measured against this repository's own database through Prisma 6.1.0
 * (SQLite 3.45.0). SQLite's `ln()`, `exp()`, `log()` and `pow()` live behind
 * the `SQLITE_ENABLE_MATH_FUNCTIONS` compile-time flag, and the SQLite that
 * Prisma's query engine bundles is not built with it. There is no runtime
 * switch, and Prisma exposes no way to register a user-defined function on the
 * connection, so no amount of raw SQL reaches `exp()`. Emulating the decay
 * with the operators SQLite does have is not possible either — `exp` is not
 * expressible in `+ - * /`.
 *
 * What the criterion actually pins is the ORDER — "ordered by
 * `ln(1+clapTotal) + 2.0*exp(-ageHours/72.0)` DESC with ties broken by
 * publishedAt DESC then id ASC against a fixed injected clock" — and that is
 * preserved exactly. `queries.ts` narrows to the published set and aggregates
 * the clap totals in ONE statement (the thing the 50ms budget exists to
 * protect), then this module applies the formula. The formula is the spec's,
 * character for character; only the machine evaluating it moved.
 *
 * There is a real upside to the move, and it is worth stating so this is not
 * read as damage control: with the score in SQL, the acceptance test would
 * have had to restate the formula in TypeScript to predict an expected order,
 * and two copies of a formula in two languages is exactly the drift the
 * "one canonical formula" heading is trying to prevent. Here the test and the
 * product evaluate the same function.
 *
 * ── Why `now` is a parameter everywhere ───────────────────────────────────
 * SPEC-008: "evaluated against a clock injected as a parameter so tests are
 * deterministic". Nothing in this file reads `Date.now()`. A default argument
 * would be convenient and would also make every ranking test depend on the
 * wall clock, which is how a suite starts passing at 09:00 and failing at
 * midnight.
 */

/** SPEC-008: "page size **20**". The one place this number is written. */
export const FEED_PAGE_SIZE = 20;

/** The `2.0` multiplier on the recency term. */
export const RECENCY_WEIGHT = 2.0;

/** The `72.0` in `exp(-ageHours / 72.0)` — the decay constant, in hours. */
export const DECAY_HOURS = 72.0;

/** SPEC-008: `ageHours = (now - publishedAt) / 3600000`. */
export const MS_PER_HOUR = 3_600_000;

/**
 * The minimum a row must carry to be ordered.
 *
 * `publishedAt` is non-nullable here even though the column is nullable: an
 * article with no publication instant has no age, so it has no score. The
 * queries filter `publishedAt IS NOT NULL` rather than inventing a fallback —
 * a `?? createdAt` here would silently give unpublished-but-PUBLISHED rows a
 * plausible position in the feed instead of surfacing the data defect.
 */
export interface Rankable {
  id: string;
  publishedAt: Date;
  /** `SUM(Clap.count)` for the article — SPEC-004 never stores this. */
  clapTotal: number;
}

/** A `Rankable` with its score attached, as produced by `rankArticles`. */
export type Ranked<T extends Rankable = Rankable> = T & { score: number };

/**
 * `(now - publishedAt) / 3600000`.
 *
 * Signed on purpose. An article published in the future relative to the
 * injected clock has a negative age, which the formula turns into a score
 * above every real article's. That is the spec's arithmetic followed
 * literally, and clamping it would be inventing a rule SPEC-008 does not
 * state — a future `publishedAt` is a data defect, and a feed that shows it
 * at the top is a far louder report of that defect than one that quietly
 * files it in the middle.
 */
export function ageHours(publishedAt: Date, now: Date): number {
  return (now.getTime() - publishedAt.getTime()) / MS_PER_HOUR;
}

/**
 * SPEC-008's score, verbatim: `ln(1 + clapTotal) + 2.0 * exp(-ageHours/72.0)`.
 *
 * `Math.log` IS the natural logarithm in JavaScript — `Math.log10` and
 * `Math.log2` are the other two. Worth saying out loud, because reading
 * `Math.log` as log base 10 is the single most likely way this line gets
 * "fixed" into something wrong.
 */
export function feedScore(row: Pick<Rankable, 'publishedAt' | 'clapTotal'>, now: Date): number {
  const decay = Math.exp(-ageHours(row.publishedAt, now) / DECAY_HOURS);
  return Math.log(1 + row.clapTotal) + RECENCY_WEIGHT * decay;
}

/**
 * SPEC-008's total order: `score DESC, publishedAt DESC, id ASC`.
 *
 * ── Why the tiebreak chain is not optional ────────────────────────────────
 * "Ties break by `publishedAt DESC` then `id ASC` — the order is **total**,
 * never arbitrary." A cursor walks this order, and a cursor over a partial
 * order repeats rows and skips rows. Ties are not hypothetical here: the seed
 * corpus is written against a fixed clock (SPEC-002 requires determinism), so
 * articles share `publishedAt` by construction, and every article with zero
 * claps and the same instant has a bit-identical score.
 *
 * Both fields are compared even when the scores differ, so this function
 * answers "which of these two rows comes first" for ANY pair — which is what
 * makes it safe to use as both a sort comparator and a cursor predicate.
 */
export function compareRanked(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score; // score DESC
  const at = a.publishedAt.getTime();
  const bt = b.publishedAt.getTime();
  if (at !== bt) return bt - at; // publishedAt DESC
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id ASC
}

/**
 * Score every row and sort into SPEC-008's order.
 *
 * Returns a new array; the input is not mutated, because callers pass query
 * results they may also be reading by id.
 */
export function rankArticles<T extends Rankable>(rows: readonly T[], now: Date): Ranked<T>[] {
  return rows
    .map((row) => ({ ...row, score: feedScore(row, now) }))
    .sort(compareRanked);
}

/**
 * Reverse-chronological order: `publishedAt DESC, id ASC`.
 *
 * Used by the Following tab and by `/tag/[slug]`, both of which SPEC-008
 * defines as "no scoring". Expressed as a score of zero for every row rather
 * than as a second comparator, so those surfaces walk the SAME total order and
 * the SAME cursor machinery as the ranked feed: with all scores equal,
 * `compareRanked` degenerates to exactly `publishedAt DESC, id ASC`.
 *
 * One order, one cursor, one place a paging bug can live.
 */
export function chronological<T extends Rankable>(rows: readonly T[]): Ranked<T>[] {
  return rows.map((row) => ({ ...row, score: 0 })).sort(compareRanked);
}
