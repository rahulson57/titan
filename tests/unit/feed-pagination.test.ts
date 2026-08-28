/**
 * Cursor pagination over the whole corpus (SPEC-008).
 *
 * > Paging through the full 500-article seed corpus with the cursor yields 500
 * > distinct article ids with no duplicates and no omissions.
 *
 * > Cursor-based, never `OFFSET`. [...] A cursor is stable across a page-2
 * > request even if new articles are published in between (no duplicates, no
 * > skips within a paging session).
 *
 * ── Why the real seed corpus and not a fixture ────────────────────────────
 * The criterion names it, and it is not decoration. 500 rows written against a
 * fixed clock (SPEC-002 requires determinism) means ties in `publishedAt` by
 * construction, and ties are what break cursor pagination: a cursor over a
 * non-total order repeats rows or skips them, and it does so only once the
 * data has ties — which is to say in front of a reader rather than in a
 * three-row fixture. A hand-built corpus would have to reproduce that property
 * deliberately, and would then be testing the fixture author's idea of the
 * hazard rather than the corpus the product actually ships with.
 *
 * ── What "no omissions" is checked against ───────────────────────────────
 * Not against the number 500 alone. Counting to 500 passes if the walk visits
 * one article twice and misses another, so the walk's ids are compared as a
 * SET against every published id in the database. The count is asserted too,
 * because a set comparison alone would pass a walk that returned each id twice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { createTestDatabase, REPO_ROOT, type TestDatabase } from '../helpers/db';
import { disconnectDb, getDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import { getFeedPage } from '../../lib/feed/queries';
import { FEED_PAGE_SIZE } from '../../lib/feed/rank';
import { clockFor, decodeCursor, encodeCursor, sortsAfterCursor } from '../../lib/feed/cursor';

/** SPEC-002's corpus: 500 PUBLISHED articles (plus 40 drafts). */
const PUBLISHED_IN_CORPUS = 500;

/** The clock every page in a walk is ranked against. */
const NOW = new Date('2026-06-01T00:00:00.000Z');

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  execFileSync('npm', ['run', 'db:seed'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: db.url },
  });
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

/** Every published id in the database, straight from SQL. */
async function publishedIds(): Promise<string[]> {
  const rows = await getDb().article.findMany({
    where: { status: 'PUBLISHED' },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Walk the feed to exhaustion, exactly as a reader clicking "Older stories"
 * would: page 1 with an injected clock, every later page with only the cursor.
 */
async function walkFeed(pageSize = FEED_PAGE_SIZE): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const page: Awaited<ReturnType<typeof getFeedPage>> = await getFeedPage(
      cursor === null ? { now: NOW, limit: pageSize } : { cursor, limit: pageSize },
    );
    if (page.length === 0) break;

    pages += 1;
    ids.push(...page.map((item) => item.id));
    cursor = page[page.length - 1]?.cursor ?? null;

    // A walk that cannot terminate is a defect in its own right, and an
    // infinite loop in a test suite reports as a timeout with no clue why.
    if (pages > 1000) throw new Error('feed walk did not terminate');
  }

  return { ids, pages };
}

describe('SPEC-008 — paging the full seed corpus', () => {
  it('the corpus is the one the criterion names', async () => {
    expect(await publishedIds()).toHaveLength(PUBLISHED_IN_CORPUS);
  });

  it('yields 500 distinct ids with no duplicates and no omissions', async () => {
    const { ids, pages } = await walkFeed();

    expect(ids).toHaveLength(PUBLISHED_IN_CORPUS);
    expect(new Set(ids).size).toBe(PUBLISHED_IN_CORPUS);
    expect([...new Set(ids)].sort()).toEqual([...(await publishedIds())].sort());
    // 500 / 20 = 25 full pages, then one empty page ends the walk.
    expect(pages).toBe(PUBLISHED_IN_CORPUS / FEED_PAGE_SIZE);
  });

  it('is exhaustive at a page size that does not divide the corpus', async () => {
    // 7 leaves a partial last page — the boundary where an off-by-one in the
    // cursor predicate stops being invisible.
    const { ids } = await walkFeed(7);
    expect(new Set(ids).size).toBe(PUBLISHED_IN_CORPUS);
    expect(ids).toHaveLength(PUBLISHED_IN_CORPUS);
  });

  it('never repeats the cursor row as the first row of the next page', async () => {
    const first = await getFeedPage({ now: NOW });
    const second = await getFeedPage({ cursor: first[first.length - 1]?.cursor });
    expect(second[0]?.id).not.toBe(first[first.length - 1]?.id);
    expect(first.map((i) => i.id).filter((id) => second.some((s) => s.id === id))).toEqual([]);
  });

  it('is stable when an article is published between page 1 and page 2', async () => {
    const first = await getFeedPage({ now: NOW, limit: 5 });
    const cursor = first[first.length - 1]?.cursor ?? null;

    // A brand-new article, published AFTER the paging session's clock. Under a
    // moving clock this row would score above everything and shove the whole
    // ordering down by one, so page 2 would repeat a row from page 1.
    const author = await createUser({
      email: 'interloper@titan.test',
      passwordHash: 'x',
      handle: 'interloper',
      name: 'Interloper',
    });
    const fresh = await createArticle({
      authorId: author.id,
      title: 'Published mid-session',
      subtitle: null,
      bodyJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new' }] }] },
      bodyHtml: '<p>new</p>',
      status: 'PUBLISHED',
      now: new Date(NOW.getTime() + 60_000),
    });

    const second = await getFeedPage({ cursor, limit: 5 });

    expect(second.map((i) => i.id)).not.toContain(fresh.id);
    for (const item of first) expect(second.map((i) => i.id)).not.toContain(item.id);

    // And it IS present in a session started afterwards — excluded from the
    // running session, not lost. Deliberately not asserted to be FIRST: the
    // seed corpus contains articles with hundreds of claps, whose `ln` term
    // outweighs a fresh article's recency term of 2, and pinning first place
    // here would be asserting something SPEC-008's formula does not promise.
    const restarted = await getFeedPage({ now: new Date(NOW.getTime() + 120_000), limit: 600 });
    expect(restarted.map((i) => i.id)).toContain(fresh.id);
  });
});

describe('SPEC-008 — the cursor token itself', () => {
  const anchor = { score: 1.5, publishedAt: new Date('2026-06-01T10:00:00.000Z'), id: 'abc' };

  it('round-trips through base64url', () => {
    const decoded = decodeCursor(encodeCursor(anchor, NOW));
    expect(decoded).toEqual({
      score: 1.5,
      publishedAt: anchor.publishedAt.toISOString(),
      id: 'abc',
      now: NOW.toISOString(),
    });
  });

  it('is URL-safe — no +, / or = to be mangled in a query string', () => {
    const token = encodeCursor({ ...anchor, id: 'a'.repeat(40) }, NOW);
    expect(token).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('answers null for anything that is not a cursor, rather than throwing', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!!!not base64!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('not json').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('[]').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('null').toString('base64url'))).toBeNull();
  });

  it('rejects a payload whose fields would poison the comparison', () => {
    const bad = (payload: unknown) => decodeCursor(Buffer.from(JSON.stringify(payload)).toString('base64url'));
    const good = { score: 1, publishedAt: NOW.toISOString(), id: 'x', now: NOW.toISOString() };

    // `NaN` compares false against everything, which would silently produce a
    // feed in an undefined order rather than an error.
    expect(bad({ ...good, score: 'top' })).toBeNull();
    expect(bad({ ...good, score: null })).toBeNull();
    expect(bad({ ...good, publishedAt: 'yesterday' })).toBeNull();
    expect(bad({ ...good, id: '' })).toBeNull();
    expect(bad({ ...good, id: 7 })).toBeNull();
    expect(bad({ ...good, now: 'soon' })).toBeNull();
    expect(bad(good)).not.toBeNull();
  });

  it('pins the paging session to the clock the session started with', () => {
    const later = new Date(NOW.getTime() + 86_400_000);
    const cursor = decodeCursor(encodeCursor(anchor, NOW));
    expect(clockFor(cursor, later).toISOString()).toBe(NOW.toISOString());
    expect(clockFor(null, later)).toBe(later);
  });

  it('orders strictly — the cursor row is never after itself', () => {
    const cursor = decodeCursor(encodeCursor(anchor, NOW));
    if (!cursor) throw new Error('cursor did not decode');

    expect(sortsAfterCursor(anchor, cursor)).toBe(false);
    expect(sortsAfterCursor({ ...anchor, score: 1.4 }, cursor)).toBe(true);
    expect(sortsAfterCursor({ ...anchor, score: 1.6 }, cursor)).toBe(false);
    expect(
      sortsAfterCursor({ ...anchor, publishedAt: new Date(anchor.publishedAt.getTime() - 1) }, cursor),
    ).toBe(true);
    expect(
      sortsAfterCursor({ ...anchor, publishedAt: new Date(anchor.publishedAt.getTime() + 1) }, cursor),
    ).toBe(false);
    expect(sortsAfterCursor({ ...anchor, id: 'abd' }, cursor)).toBe(true);
    expect(sortsAfterCursor({ ...anchor, id: 'abb' }, cursor)).toBe(false);
  });
});
