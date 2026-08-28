/**
 * The seed corpus's exact shape (SPEC-004).
 *
 * > `npm run db:seed` produces exactly 50 users, 540 articles (500 PUBLISHED +
 * > 40 DRAFT), 30 tags, 2000 claps, 400 follows, 300 bookmarks.
 *
 * "Exactly" is what makes every downstream budget meaningful: SPEC-002 states
 * its p95 targets against this corpus, so a seed that quietly produced 200
 * articles would make the feed budget pass for the wrong reason. The counts are
 * therefore asserted against `COUNT(*)` on a freshly-migrated throwaway
 * database, by running the real `npm run db:seed` — not by importing the seed
 * module and inspecting what it intended to write.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, REPO_ROOT, type TestDatabase } from '../helpers/db';

/** SPEC-004's corpus, restated here rather than imported from the seed. */
const EXPECTED = {
  User: 50,
  Article: 540,
  Tag: 30,
  Clap: 2_000,
  Follow: 400,
  Bookmark: 300,
} as const;

const PUBLISHED = 500;
const DRAFTS = 40;

let db: TestDatabase;

async function scalar(sql: string, ...values: unknown[]): Promise<number> {
  const rows = await db.client.$queryRawUnsafe<Array<{ n: bigint | number }>>(sql, ...values);
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createTestDatabase();
  execFileSync('npm', ['run', 'db:seed'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: db.url },
  });
}, 180_000);

afterAll(async () => {
  await db.drop();
});

describe('SPEC-004 — the corpus is exactly the documented size', () => {
  it.each(Object.entries(EXPECTED))('seeds %s = %i', async (table, expected) => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM "${table}"`)).toBe(expected);
  });

  it('splits articles 500 PUBLISHED + 40 DRAFT', async () => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM "Article" WHERE status = 'PUBLISHED'`)).toBe(
      PUBLISHED,
    );
    expect(await scalar(`SELECT COUNT(*) AS n FROM "Article" WHERE status = 'DRAFT'`)).toBe(DRAFTS);
    expect(PUBLISHED + DRAFTS).toBe(EXPECTED.Article);
  });

  it('gives every published article a publishedAt and every draft none', async () => {
    expect(
      await scalar(
        `SELECT COUNT(*) AS n FROM "Article" WHERE status = 'PUBLISHED' AND publishedAt IS NULL`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        `SELECT COUNT(*) AS n FROM "Article" WHERE status = 'DRAFT' AND publishedAt IS NOT NULL`,
      ),
    ).toBe(0);
  });
});

describe('SPEC-004 — the corpus obeys the rules the repositories enforce', () => {
  it('never exceeds five tags on an article', async () => {
    const worst = await scalar(
      `SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM "ArticleTag" GROUP BY articleId)`,
    );
    expect(worst).toBeLessThanOrEqual(5);
    expect(worst).toBeGreaterThan(0);
  });

  it('keeps every clap inside 1..50, one row per (user, article)', async () => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM "Clap" WHERE count < 1 OR count > 50`)).toBe(0);
    expect(
      await scalar(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM "Clap" GROUP BY userId, articleId HAVING COUNT(*) > 1)`,
      ),
    ).toBe(0);
  });

  it('contains no self-follow', async () => {
    expect(
      await scalar(`SELECT COUNT(*) AS n FROM "Follow" WHERE followerId = followingId`),
    ).toBe(0);
  });

  it('gives every article a unique slug', async () => {
    expect(
      await scalar(`SELECT COUNT(*) AS n FROM (SELECT slug FROM "Article" GROUP BY slug HAVING COUNT(*) > 1)`),
    ).toBe(0);
  });

  it('writes bodies inside the documented 400-1800 word range', async () => {
    const shortest = await scalar(
      `SELECT MIN(LENGTH(bodyText) - LENGTH(REPLACE(bodyText, ' ', '')) + 1) AS n FROM "Article"`,
    );
    const longest = await scalar(
      `SELECT MAX(LENGTH(bodyText) - LENGTH(REPLACE(bodyText, ' ', '')) + 1) AS n FROM "Article"`,
    );
    expect(shortest).toBeGreaterThanOrEqual(400);
    expect(longest).toBeLessThanOrEqual(1_800);
  });

  it('derives readingMinutes from the stored bodyText, not from a guess', async () => {
    // If the seed wrote a reading time that does not follow from the text it
    // also wrote, every article page renders a number no test would catch.
    const rows = await db.client.$queryRawUnsafe<Array<{ readingMinutes: number; bodyText: string }>>(
      'SELECT readingMinutes, bodyText FROM "Article" LIMIT 40',
    );
    for (const row of rows) {
      const words = row.bodyText.split(/\s+/).filter(Boolean).length;
      expect(row.readingMinutes).toBe(Math.max(1, Math.ceil(words / 238)));
    }
  });
});

describe('SPEC-004/SPEC-008 — the FTS5 index holds the published corpus only', () => {
  it('indexes exactly the 500 published articles', async () => {
    // The specific way a search budget passes for the wrong reason is an empty
    // index: nothing to intersect is very fast indeed.
    expect(await scalar(`SELECT COUNT(*) AS n FROM "article_fts"`)).toBe(PUBLISHED);
  });

  it('cannot surface a draft', async () => {
    const leaked = await db.client.$queryRawUnsafe<Array<{ title: string }>>(
      `SELECT f.title FROM "article_fts" f
        WHERE f.rowid IN (SELECT rowid FROM "Article" WHERE status = 'DRAFT')`,
    );
    expect(leaked).toEqual([]);
  });

  it('answers a two-token stemmed query over the corpus', async () => {
    const rows = await db.client.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM "article_fts" WHERE "article_fts" MATCH 'design systems'`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});

describe('SPEC-002 — the corpus is reproducible, not merely repeatable', () => {
  it('is derived from the fixed PRNG seed and base timestamp', async () => {
    const source = readFileSync(join(REPO_ROOT, 'prisma', 'seed.ts'), 'utf8');
    expect(source).toContain('titan-2026');
    expect(source).toMatch(/2026-01-01T00:00:00/);
  });

  it('places every createdAt at or after the base timestamp', async () => {
    // A row dated before the base is proof the seed read a wall clock.
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (const table of ['User', 'Article'] as const) {
      const rows = await db.client.$queryRawUnsafe<Array<{ createdAt: Date }>>(
        `SELECT createdAt FROM "${table}"`,
      );
      for (const row of rows) {
        expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('re-seeds into a rebuild rather than a pile-up', async () => {
    // `npm run setup` is documented as re-runnable; a second seed that appended
    // would double the corpus and break every budget stated against it.
    execFileSync('npm', ['run', 'db:seed'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: { ...process.env, DATABASE_URL: db.url },
    });
    expect(await scalar(`SELECT COUNT(*) AS n FROM "Article"`)).toBe(EXPECTED.Article);
    expect(await scalar(`SELECT COUNT(*) AS n FROM "Clap"`)).toBe(EXPECTED.Clap);
    expect(await scalar(`SELECT COUNT(*) AS n FROM "article_fts"`)).toBe(PUBLISHED);
  }, 120_000);
});
