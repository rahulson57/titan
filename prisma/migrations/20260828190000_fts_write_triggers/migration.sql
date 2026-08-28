-- The FTS5 write triggers (SPEC-008), moved out of application code.
--
-- ── What this migration is, and why it exists ─────────────────────────────
-- The init migration created `article_fts` and its content view and said, in
-- its own comment, that "the write TRIGGERS that keep this in step with
-- `Article` are owned by SPEC-008 (Feed & Search) and are deliberately NOT
-- created here". SPEC-008 landed them, but with no migration in its file
-- scope to put them in, so `lib/search/fts.ts` installed them LAZILY on the
-- first call into the search module.
--
-- That made the index's maintenance a property of EXECUTION ORDER rather than
-- of the schema, and the cost was measured rather than theoretical: `npm test`
-- runs `vitest run && playwright test`, the unit search suites install the
-- triggers as a side effect, and so the e2e half only ever saw a triggered
-- database because the unit half had run first against the same file. Running
-- `playwright test tests/e2e/publish-flow.spec.ts` on its own skipped the
-- "unpublished article leaves the FTS index" test — 1 skipped before the gate,
-- 0 after, same commit — and the skip reason blamed a slice that had landed
-- long before.
--
-- Here, the triggers are part of the database file from the moment
-- `prisma migrate deploy` returns: every connection sees them, including
-- processes that never import the search module (`npm run db:seed`, a
-- `sqlite3` shell, an isolated Playwright run). The identical DDL still lives
-- in `lib/search/fts.ts` as `SEARCH_TRIGGER_SQL`, but only as the repair path
-- behind `npm run search:reindex` — `CREATE TRIGGER IF NOT EXISTS` there now
-- finds them already present and does nothing.
--
-- `IF NOT EXISTS` is load-bearing HERE too, and not only for style: databases
-- that predate this migration already have these triggers, installed by that
-- lazy path under the same names. This migration must be a no-op on them
-- rather than an error that leaves `_prisma_migrations` marked failed.
--
-- ── Why UPDATE is ONE trigger with two conditional statements ─────────────
-- The obvious shape is two triggers — `WHEN old.status='PUBLISHED'` to remove
-- and `WHEN new.status='PUBLISHED'` to add. It is wrong, and it fails in the
-- most common case rather than an exotic one. SQLite does not define the order
-- in which several triggers on the same event fire, so the insert may run
-- before the delete; when a published article is updated without changing its
-- indexed text, both statements carry identical values, and delete-after-
-- insert removes the row that had just been re-added. The article disappears
-- from search because someone edited its cover image.
--
-- One trigger fixes it: statements inside a single trigger body execute in the
-- order written, so the removal always precedes the insertion. The conditions
-- ride on `INSERT ... SELECT ... WHERE` because SQLite's trigger language has
-- no `IF`, and a trigger-level `WHEN` would apply to the whole body rather
-- than to one statement.
--
-- ── Why the deletes restate the old values ───────────────────────────────
-- `article_fts` is an EXTERNAL CONTENT table: it stores the inverted index but
-- not the text, and reads the text back from `article_fts_source`. FTS5 cannot
-- look up what it needs to remove — the content row is already gone or already
-- changed by the time an AFTER trigger runs — so a deletion must RESTATE the
-- old values. Getting them wrong raises no error; it corrupts the index
-- silently. `coalesce(subtitle, '')` mirrors the view's own COALESCE for the
-- same reason: without it a NULL subtitle would index as NULL where the view
-- produced '', and the trigger-maintained index and a rebuild would disagree —
-- which is exactly what `npm run search:reindex` is specified to prove they
-- never do.

-- CreateTrigger
CREATE TRIGGER IF NOT EXISTS "article_fts_ai" AFTER INSERT ON "Article" BEGIN
     INSERT INTO "article_fts"("rowid", "title", "subtitle", "body")
       SELECT new."rowid", new."title", coalesce(new."subtitle", ''), new."bodyText"
       WHERE new."status" = 'PUBLISHED';
   END;

-- CreateTrigger
CREATE TRIGGER IF NOT EXISTS "article_fts_au" AFTER UPDATE ON "Article" BEGIN
     INSERT INTO "article_fts"("article_fts", "rowid", "title", "subtitle", "body")
       SELECT 'delete', old."rowid", old."title", coalesce(old."subtitle", ''), old."bodyText"
       WHERE old."status" = 'PUBLISHED';
     INSERT INTO "article_fts"("rowid", "title", "subtitle", "body")
       SELECT new."rowid", new."title", coalesce(new."subtitle", ''), new."bodyText"
       WHERE new."status" = 'PUBLISHED';
   END;

-- CreateTrigger
CREATE TRIGGER IF NOT EXISTS "article_fts_ad" AFTER DELETE ON "Article" BEGIN
     INSERT INTO "article_fts"("article_fts", "rowid", "title", "subtitle", "body")
       SELECT 'delete', old."rowid", old."title", coalesce(old."subtitle", ''), old."bodyText"
       WHERE old."status" = 'PUBLISHED';
   END;

-- The window-closer.
--
-- Triggers only maintain what happens AFTER they exist. On a fresh database
-- this rebuild is a no-op over an empty `Article`. On a database that already
-- carries published rows — anything deployed before this migration — it
-- re-reads the whole index from `article_fts_source`, the view that already
-- filters to `status = 'PUBLISHED'`, so the index is exactly the published set
-- whatever happened in the window before the triggers landed.
INSERT INTO "article_fts"("article_fts") VALUES('rebuild');
