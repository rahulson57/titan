/**
 * The migrated schema (SPEC-004).
 *
 * > `npx prisma migrate deploy` on an empty `./data/` creates all 8 tables plus
 * > the FTS5 virtual table with zero errors […] querying `sqlite_master`.
 * > Every table listed in the Indexes block has its named index present in
 * > `sqlite_master`.
 *
 * Asserted against `sqlite_master` rather than against `schema.prisma`, because
 * the thing that has to be right is the DATABASE the migration produces. A
 * schema file can be correct while the migration that ships alongside it is
 * stale — `prisma/migrations/**` is append-only, so the two are separate
 * artefacts and only one of them is what actually runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { CONNECTION_PRAGMAS, DEFAULT_DATABASE_URL, databaseUrl, disconnectDb, getDb, readPragma } from '../../lib/db/client';

/** SPEC-004's entity list. Exactly these, and the FTS5 table alongside them. */
const TABLES = [
  'User',
  'Article',
  'Tag',
  'ArticleTag',
  'Follow',
  'Clap',
  'Bookmark',
  'Session',
] as const;

/** SPEC-004's Indexes block, one entry per line of it. */
const INDEXES = {
  'Article(status, publishedAt DESC)': 'Article_status_publishedAt_idx',
  'Article(authorId, status)': 'Article_authorId_status_idx',
  'ArticleTag(tagId)': 'ArticleTag_tagId_idx',
  'Clap(articleId)': 'Clap_articleId_idx',
  'Bookmark(userId, createdAt DESC)': 'Bookmark_userId_createdAt_idx',
  'Follow(followerId)': 'Follow_followerId_idx',
  'Follow(followingId)': 'Follow_followingId_idx',
} as const;

let db: TestDatabase;
let objects: Array<{ type: string; name: string; sql: string | null }>;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  objects = await db.client.$queryRawUnsafe(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

const named = (type: string, name: string) =>
  objects.some((row) => row.type === type && row.name === name);

describe('SPEC-004 — migrate deploy creates the whole schema', () => {
  it.each(TABLES)('creates the %s table', (table) => {
    expect(named('table', table)).toBe(true);
  });

  it('creates exactly the eight entities SPEC-004 names, and no extra model table', () => {
    // Prisma's own bookkeeping table and FTS5's shadow tables are
    // infrastructure, not entities; anything else appearing here would be a
    // model somebody added without a spec change.
    const models = objects
      .filter((row) => row.type === 'table')
      .map((row) => row.name)
      .filter((name) => name !== '_prisma_migrations' && !name.startsWith('article_fts'));
    expect(models.sort()).toEqual([...TABLES].sort());
  });

  it('creates the FTS5 virtual table', () => {
    const fts = objects.find((row) => row.name === 'article_fts');
    expect(fts, 'article_fts is missing — search would fall back to a LIKE scan').toBeDefined();
    expect(fts?.sql).toMatch(/fts5/i);
  });

  it('gives the FTS5 table the tokenizer and column order SPEC-008 ranks against', () => {
    const sql = objects.find((row) => row.name === 'article_fts')?.sql ?? '';
    // bm25(article_fts, 10.0, 5.0, 1.0) weights BY POSITION, and
    // snippet(article_fts, 2, …) addresses `body` by index. Both break silently
    // if these three columns are ever reordered.
    expect(sql.indexOf('title')).toBeLessThan(sql.indexOf('subtitle'));
    expect(sql.indexOf('subtitle')).toBeLessThan(sql.indexOf('body'));
    expect(sql).toMatch(/porter\s+unicode61/);
  });

  it('backs the index with a view that can only expose PUBLISHED rows', () => {
    // SPEC-008: "Zero DRAFT articles appear in /, /tag/[slug], or /search".
    // Enforcing it in the content source means no query has to remember it.
    const view = objects.find((row) => row.type === 'view' && row.name === 'article_fts_source');
    expect(view).toBeDefined();
    expect(view?.sql).toMatch(/'PUBLISHED'/);
  });
});

describe('SPEC-004 — every index in the Indexes block exists by name', () => {
  it.each(Object.entries(INDEXES))('%s -> %s', (_spec, indexName) => {
    expect(named('index', indexName)).toBe(true);
  });

  it('keeps the unique constraints the natural keys depend on', () => {
    for (const unique of ['User_email_key', 'User_handle_key', 'Article_slug_key', 'Tag_slug_key']) {
      expect(named('index', unique), `${unique} is missing`).toBe(true);
    }
  });
});

describe('SPEC-004 — the app connection', () => {
  it('runs in WAL mode', async () => {
    expect(String(await readPragma('journal_mode')).toLowerCase()).toBe('wal');
  });

  it('enforces foreign keys', async () => {
    // Returned as a BigInt by the raw driver, hence Number(): `toBe(1)` on the
    // raw value would compare 1n to 1 and fail for the wrong reason.
    expect(Number(await readPragma('foreign_keys'))).toBe(1);
  });

  it('waits rather than failing fast when the single writer is busy', async () => {
    expect(Number(await readPragma('busy_timeout'))).toBe(5_000);
  });

  it('pins the pool to one connection so a pragma applies to the whole app', () => {
    // With a pool of N, `PRAGMA foreign_keys=ON` lands on whichever connection
    // served that statement and the other N-1 silently run without it.
    expect(databaseUrl()).toContain('connection_limit=1');
    expect(CONNECTION_PRAGMAS).toContain('foreign_keys = ON');
  });

  it('memoises the client per datasource URL', () => {
    expect(getDb()).toBe(getDb());
  });

  it('falls back to SPEC-001 boot contract path when DATABASE_URL is unset', () => {
    const saved = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      expect(databaseUrl()).toBe(`${DEFAULT_DATABASE_URL}?connection_limit=1`);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
