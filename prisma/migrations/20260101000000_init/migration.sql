-- titan — initial schema (SPEC-004).
--
-- `prisma/migrations/**` is APPEND-ONLY. Editing a shipped migration is
-- forbidden; correct it with a new one.
--
-- Two statements here are not generated from `schema.prisma`, and both are
-- deliberate:
--
--  1. `PRAGMA journal_mode = WAL` (below). WAL is a persistent property of the
--     database FILE, not of a connection, so setting it at creation time makes
--     every later connection inherit it — including connections opened by
--     tooling that never loads `lib/db/client.ts`. SPEC-001 states the
--     criterion as an invariant of the app connection ("every PRAGMA
--     journal_mode returns wal"); putting it here is what makes that true for
--     connections the app does not own, which is exactly what
--     `tests/unit/db-pragmas.test.ts` opens. Setting it only in the client
--     would leave a freshly-migrated database in `delete` mode until the app
--     happened to touch it.
--
--  2. `article_fts` (bottom). Prisma has no representation for a virtual
--     table, so the FTS5 index SPEC-004's acceptance criteria require
--     ("creates all 8 tables plus the FTS5 virtual table") has to be written
--     by hand. Its write TRIGGERS are owned by SPEC-008 (Feed & Search) and
--     are deliberately NOT created here — this migration creates the table
--     shape those triggers will maintain, nothing more.

-- Enable write-ahead logging before anything else writes to the file.
PRAGMA journal_mode = WAL;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bio" TEXT,
    "avatarPath" TEXT,
    "coverPath" TEXT,
    "socials" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "bodyJson" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "coverPath" TEXT,
    "readingMinutes" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Article_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ArticleTag" (
    "articleId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("articleId", "tagId"),
    CONSTRAINT "ArticleTag_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArticleTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Follow" (
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,

    PRIMARY KEY ("followerId", "followingId"),
    CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Clap" (
    "userId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "articleId"),
    CONSTRAINT "Clap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Clap_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "userId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "articleId"),
    CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Bookmark_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Article_slug_key" ON "Article"("slug");

-- CreateIndex
CREATE INDEX "Article_status_publishedAt_idx" ON "Article"("status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "Article_authorId_status_idx" ON "Article"("authorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_key" ON "Tag"("slug");

-- CreateIndex
CREATE INDEX "ArticleTag_tagId_idx" ON "ArticleTag"("tagId");

-- CreateIndex
CREATE INDEX "Follow_followerId_idx" ON "Follow"("followerId");

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "Follow"("followingId");

-- CreateIndex
CREATE INDEX "Clap_articleId_idx" ON "Clap"("articleId");

-- CreateIndex
CREATE INDEX "Bookmark_userId_createdAt_idx" ON "Bookmark"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");


-- CreateView
-- The content source for the full-text index.
--
-- SPEC-008 specifies `article_fts(title, subtitle, body, content='Article',
-- content_rowid=...)`. That exact form cannot be created: FTS5's external-
-- content mode resolves a row by running `SELECT <col>, ... FROM <content>
-- WHERE <content_rowid> = ?` using the FTS table's OWN column names, and
-- "Article" has no `body` column — SPEC-004 names it `bodyText`. Pointing
-- `content` straight at "Article" builds, but every read fails at runtime with
-- `no such column: T.body`, including the plain `SELECT COUNT(*) FROM
-- article_fts` that tests/perf/search-query.test.ts uses to prove the index is
-- populated.
--
-- This view is the smallest thing that keeps SPEC-008's actual choice —
-- external content, so 500 article bodies are not stored twice — while
-- satisfying FTS5's naming rule: it renames `bodyText` to `body` and nothing
-- else. It also moves one of SPEC-008's own rules into the schema rather than
-- leaving it to query discipline: the WHERE clause means a DRAFT article
-- CANNOT be in the search index, which is the criterion "zero DRAFT articles
-- appear in /, /tag/[slug], or /search". A rebuild
-- (`INSERT INTO article_fts(article_fts) VALUES('rebuild')`) therefore
-- reproduces exactly the published set, which is what makes SPEC-008's
-- `npm run search:reindex` comparable against the trigger-maintained index.
CREATE VIEW "article_fts_source" AS
    SELECT "rowid"                 AS "rowid",
           "title"                 AS "title",
           COALESCE("subtitle", '') AS "subtitle",
           "bodyText"              AS "body"
      FROM "Article"
     WHERE "status" = 'PUBLISHED';

-- CreateVirtualTable
-- Full-text index over published article prose (SPEC-008 / DEC-004).
--
-- `porter unicode61` gives stemming, which is what makes "system" match
-- "systems". Column order is load-bearing: SPEC-008 ranks with
-- `bm25(article_fts, 10.0, 5.0, 1.0)` — title 10x, subtitle 5x, body 1x — and
-- bm25's weights are positional. `snippet(article_fts, 2, ...)` likewise
-- addresses `body` by index 2. Reordering these columns silently changes both.
--
-- The write TRIGGERS that keep this in step with "Article" are owned by
-- SPEC-008 (Feed & Search) and are deliberately NOT created here: this
-- migration creates the shape those triggers will maintain, nothing more.
CREATE VIRTUAL TABLE "article_fts" USING fts5(
    title,
    subtitle,
    body,
    content='article_fts_source',
    content_rowid='rowid',
    tokenize='porter unicode61'
);
