/**
 * The FTS5 index: its write triggers, its query, and its rebuild (SPEC-008).
 *
 * > | Sync | SQL triggers on Article INSERT/UPDATE/DELETE keep the index in
 * >   step — no application-level reindex to forget |
 * > | Rank | `bm25(article_fts, 10.0, 5.0, 1.0)` — title weighted 10×,
 * >   subtitle 5×, body 1× |
 * > | Snippet | `snippet(article_fts, 2, '<mark>', '</mark>', '…', 24)` |
 *
 * The virtual table and its content view are SPEC-004's, created by the init
 * migration; the write triggers are created by the migration named below.
 * Everything that QUERIES the index, and the repair path that reinstalls those
 * triggers if a database loses them, is here.
 *
 * ── The triggers are a property of the SCHEMA, not of this module ─────────
 * `prisma/migrations/20260828190000_fts_write_triggers/migration.sql` creates
 * them, so they exist in every database the moment `prisma migrate deploy`
 * returns — for every connection, including processes that never import this
 * module (`npm run db:seed`, a `sqlite3` shell, an isolated Playwright run).
 *
 * They used to be installed from HERE, lazily, on the first call into the
 * search module. That was a documented compromise rather than a design:
 * SPEC-008 owned the triggers but its "Files owned" list contained no
 * migration, so they were assigned to this slice with no file to put them in.
 * The header this replaces said that moving `SEARCH_TRIGGER_SQL` into a
 * migration verbatim would be the whole change. TASK-023 is that change, and
 * this is what it bought:
 *
 *   - Index maintenance stopped being a property of EXECUTION ORDER. `npm test`
 *     runs `vitest run && playwright test` against the same database file, the
 *     unit search suites installed the triggers as a side effect, and so the
 *     e2e half only ever saw a triggered database because the unit half had
 *     gone first. `playwright test tests/e2e/publish-flow.spec.ts` on its own
 *     skipped the FTS withdrawal test — 1 skipped before the gate, 0 after, on
 *     the same commit — and blamed a slice that had landed hours earlier.
 *   - The capability guard that skip lived behind is GONE rather than repaired
 *     (see that file). A guard that can never be false is not a guard.
 *
 * `SEARCH_TRIGGER_SQL` and `ensureSearchIndex()` stay, and are now exactly one
 * thing: the REPAIR path. `npm run search:reindex` is the tool someone reaches
 * for on a database whose triggers were dropped, and it reinstalls before it
 * rebuilds so that a rebuild is never the last correct thing to happen to the
 * index. On a migrated database `CREATE TRIGGER IF NOT EXISTS` finds all three
 * present and does nothing, and `ensureSearchIndex()` returns false.
 *
 * The install path is still followed by ONE rebuild, for the same reason the
 * migration ends with one: triggers only maintain what happens AFTER they
 * exist, and `INSERT INTO article_fts(article_fts) VALUES('rebuild')` re-reads
 * the whole index from `article_fts_source` — the view that already filters to
 * `status = 'PUBLISHED'` — so the index is exactly the published set whatever
 * happened before them.
 *
 * ── Why `content_rowid` work is not visible here ──────────────────────────
 * `article_fts` is an EXTERNAL CONTENT table: it stores the inverted index but
 * not the text, and reads the text back from `article_fts_source`. That makes
 * the delete path unusual and it is the one place these triggers can go
 * quietly wrong. FTS5 cannot look up what it needs to remove — the content row
 * is already gone or already changed by the time an AFTER trigger runs — so a
 * deletion must RESTATE the old values:
 *
 *     INSERT INTO article_fts(article_fts, rowid, title, subtitle, body)
 *     VALUES('delete', old.rowid, old.title, ...)
 *
 * Getting those values wrong does not raise an error. It corrupts the index
 * silently, leaving postings behind that point at a row which no longer
 * contains those words — a search result that outlives its article. That is
 * what `INSERT INTO article_fts(article_fts) VALUES('integrity-check')` in
 * `tests/unit/search-triggers.test.ts` is for.
 */

import { getDb, databaseUrl } from '../db/client';
import { hydrateRanked, type FeedItem } from '../feed/queries';
import { FEED_PAGE_SIZE } from '../feed/rank';
import { parseSearchQuery } from './query';

/** The FTS5 virtual table, created by SPEC-004's init migration. */
export const FTS_TABLE = 'article_fts';

/**
 * SPEC-008's bm25 weights, positional: title 10×, subtitle 5×, body 1×.
 *
 * The order is load-bearing and matches the column order the migration
 * created. Reordering the columns there silently re-weights search; the
 * migration says the same thing from its side.
 */
export const BM25_WEIGHTS = [10.0, 5.0, 1.0] as const;

/** The body column's index, for `snippet()`. Third column, zero-based. */
export const SNIPPET_COLUMN = 2;

/** Names of the three triggers, in one place so the probe and the DDL agree. */
export const SEARCH_TRIGGER_NAMES = [
  'article_fts_ai',
  'article_fts_au',
  'article_fts_ad',
] as const;

/**
 * The write triggers — the repair path's copy of the DDL.
 *
 * The canonical copy is
 * `prisma/migrations/20260828190000_fts_write_triggers/migration.sql`, and
 * these two must stay byte-equivalent: the migration is what every database
 * gets, this is what `npm run search:reindex` restores when a database has
 * lost them. A divergence would be invisible until someone repaired a database
 * into a schema no migrated database has. The migration carries the same
 * reasoning in its own comments so neither copy can be read without it.
 *
 * ── Why UPDATE is ONE trigger with two conditional statements ─────────────
 * The obvious shape is two triggers — `WHEN old.status='PUBLISHED'` to remove
 * and `WHEN new.status='PUBLISHED'` to add. It is wrong, and it fails in the
 * most common case rather than an exotic one. SQLite does not define the order
 * in which several triggers on the same event fire, so the insert may run
 * before the delete; when a published article is updated without changing its
 * indexed text, both statements carry identical values, and delete-after-
 * insert removes the row that had just been re-added. The article disappears
 * from search because someone edited its cover image.
 *
 * One trigger fixes it: statements inside a single trigger body execute in the
 * order written, so the removal always precedes the insertion. The conditions
 * ride on `INSERT ... SELECT ... WHERE` because SQLite's trigger language has
 * no `IF`, and a trigger-level `WHEN` would apply to the whole body rather
 * than to one statement.
 *
 * ── Why the UPDATE trigger is not narrowed with `OF ...` ──────────────────
 * `AFTER UPDATE OF title, subtitle, bodyText, status` would skip work on
 * unrelated column changes, and it would be one forgotten column away from a
 * stale index — a future slice adding a searchable field would have to know to
 * come here. Unconditional is cheaper to be sure about, and the work it does
 * on an unrelated update is one delete plus one insert on a 500-row index.
 *
 * `coalesce(subtitle, '')` mirrors the view's own `COALESCE(... , '')`. Without
 * it a NULL subtitle would index as NULL where the view produced '', and the
 * trigger-maintained index and a rebuild would disagree — which is exactly
 * what `npm run search:reindex` is specified to prove they never do.
 */
export const SEARCH_TRIGGER_SQL: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS "article_fts_ai" AFTER INSERT ON "Article" BEGIN
     INSERT INTO "article_fts"("rowid", "title", "subtitle", "body")
       SELECT new."rowid", new."title", coalesce(new."subtitle", ''), new."bodyText"
       WHERE new."status" = 'PUBLISHED';
   END`,
  `CREATE TRIGGER IF NOT EXISTS "article_fts_au" AFTER UPDATE ON "Article" BEGIN
     INSERT INTO "article_fts"("article_fts", "rowid", "title", "subtitle", "body")
       SELECT 'delete', old."rowid", old."title", coalesce(old."subtitle", ''), old."bodyText"
       WHERE old."status" = 'PUBLISHED';
     INSERT INTO "article_fts"("rowid", "title", "subtitle", "body")
       SELECT new."rowid", new."title", coalesce(new."subtitle", ''), new."bodyText"
       WHERE new."status" = 'PUBLISHED';
   END`,
  `CREATE TRIGGER IF NOT EXISTS "article_fts_ad" AFTER DELETE ON "Article" BEGIN
     INSERT INTO "article_fts"("article_fts", "rowid", "title", "subtitle", "body")
       SELECT 'delete', old."rowid", old."title", coalesce(old."subtitle", ''), old."bodyText"
       WHERE old."status" = 'PUBLISHED';
   END`,
];

/** `INSERT INTO article_fts(article_fts) VALUES('rebuild')`. */
const REBUILD_SQL = `INSERT INTO "article_fts"("article_fts") VALUES('rebuild')`;

/** FTS5's own consistency check. Throws when the index disagrees with content. */
const INTEGRITY_SQL = `INSERT INTO "article_fts"("article_fts") VALUES('integrity-check')`;

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Which database this process has already installed into, and the in-flight
 * install if one is running.
 *
 * Keyed on the resolved datasource URL rather than a boolean: a test suite
 * repoints `DATABASE_URL` at a throwaway file between suites, and a boolean
 * would report the NEXT database as already-installed and leave it with no
 * triggers at all — a whole suite passing against an index nothing maintains.
 *
 * The in-flight promise is shared so that twenty concurrent requests on a cold
 * process do twenty awaits and one install. Without it they would each run the
 * DDL and each rebuild the index; correct, because every statement here is
 * idempotent, but twenty rebuilds of a 500-row index on the first page load.
 */
let installedFor: string | undefined;
let installing: Promise<boolean> | undefined;

/** Are all three triggers present in this database's schema? */
export async function searchTriggersInstalled(): Promise<boolean> {
  const rows = await getDb().$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'trigger' AND "name" IN (${SEARCH_TRIGGER_NAMES.map(
      (name) => `'${name}'`,
    ).join(', ')})`,
  );
  return rows.length === SEARCH_TRIGGER_NAMES.length;
}

/**
 * Make sure the index exists, is maintained, and matches the published set.
 *
 * Returns true if this call did the installing — the reindex script reports
 * it, and `tests/unit/search-triggers.test.ts` asserts that the second call is
 * a no-op rather than a second rebuild.
 */
export async function ensureSearchIndex(): Promise<boolean> {
  const url = databaseUrl();
  if (installedFor === url) return false;
  if (installing) return installing;

  installing = (async () => {
    if (await searchTriggersInstalled()) {
      installedFor = url;
      return false;
    }

    for (const statement of SEARCH_TRIGGER_SQL) {
      await getDb().$executeRawUnsafe(statement);
    }
    // The window-closer. See the module header: without this, anything
    // published before the triggers existed is invisible to search forever.
    await getDb().$executeRawUnsafe(REBUILD_SQL);

    installedFor = url;
    return true;
  })().finally(() => {
    installing = undefined;
  });

  return installing;
}

/**
 * Rebuild the index from `Article`, the escape hatch behind
 * `npm run search:reindex`.
 *
 * Installs the triggers first if they are missing, so that a rebuild is never
 * the last correct thing that ever happens to this index.
 */
export async function rebuildSearchIndex(): Promise<void> {
  await ensureSearchIndex();
  await getDb().$executeRawUnsafe(REBUILD_SQL);
}

/** Run FTS5's own integrity check. Throws if the index disagrees with content. */
export async function checkSearchIndexIntegrity(): Promise<void> {
  await getDb().$executeRawUnsafe(INTEGRITY_SQL);
}

/** How many documents the index holds. */
export async function countIndexedArticles(): Promise<number> {
  const rows = await getDb().$queryRawUnsafe<Array<{ n: number | bigint }>>(
    `SELECT COUNT(*) AS n FROM "${FTS_TABLE}"`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** How many results. Defaults to SPEC-008's page size. */
  limit?: number;
  /** Injected clock, for the card cursors. Defaults to now. */
  now?: Date;
}

/**
 * Search published articles, best match first.
 *
 * ── Reading the ORDER BY ──────────────────────────────────────────────────
 * bm25 returns a NEGATIVE number, more negative for a better match, so
 * `ORDER BY rank` ascending is best-first. The `score` on the returned items
 * is `-rank`, flipped so that "larger is better" means the same thing on a
 * search result as it does on a feed card. Ranking search ascending and the
 * feed descending on a field with the same name would be a trap for the next
 * person to touch either.
 *
 * ── Why the join re-checks `status` ───────────────────────────────────────
 * The index cannot contain a draft: its content view filters to PUBLISHED and
 * the triggers only ever write published rows. The `AND a."status" =
 * 'PUBLISHED'` is still there because "zero DRAFT articles appear in `/search`
 * for any viewer including their own author" is a criterion about the SURFACE,
 * and a criterion worth a test is worth not resting on a second file's
 * continued correctness. It costs one comparison per matched row, and it means
 * a corrupted index degrades to missing results rather than to a leak.
 */
export async function searchArticles(
  query: string,
  options: SearchOptions = {},
): Promise<FeedItem[]> {
  const parsed = parseSearchQuery(query);
  // No tokens: nothing to match. Returning early rather than sending an empty
  // MATCH — `MATCH ''` is an FTS5 syntax error, so the empty search box would
  // 500 rather than showing the empty state the spec asks for.
  if (parsed.isEmpty) return [];

  await ensureSearchIndex();

  const limit = options.limit ?? FEED_PAGE_SIZE;
  const now = options.now ?? new Date();
  const [titleWeight, subtitleWeight, bodyWeight] = BM25_WEIGHTS;

  const rows = await getDb().$queryRawUnsafe<Array<{ id: string; rank: number; snippet: string }>>(
    `SELECT a."id" AS "id",
            bm25("${FTS_TABLE}", ${titleWeight}, ${subtitleWeight}, ${bodyWeight}) AS "rank",
            snippet("${FTS_TABLE}", ${SNIPPET_COLUMN}, '<mark>', '</mark>', '…', 24) AS "snippet"
       FROM "${FTS_TABLE}"
       JOIN "Article" a ON a."rowid" = "${FTS_TABLE}"."rowid"
      WHERE "${FTS_TABLE}" MATCH ?
        AND a."status" = 'PUBLISHED'
      ORDER BY "rank"
      LIMIT ?`,
    parsed.match,
    limit,
  );

  const snippets = new Map(rows.map((row) => [row.id, row.snippet]));

  const items = await hydrateRanked(
    // `-rank` so larger sorts first, matching the feed's sense of `score`.
    rows.map((row) => ({ id: row.id, score: -row.rank })),
    now,
  );

  return items.map((item) => ({ ...item, snippet: snippets.get(item.id) }));
}
