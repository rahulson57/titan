/**
 * The FTS5 write triggers (SPEC-008).
 *
 * > Publishing an article makes it findable by a title term within the same
 * > transaction, and unpublishing removes it from search results.
 *
 * > | Sync | SQL triggers on Article INSERT/UPDATE/DELETE keep the index in
 * >   step — no application-level reindex to forget |
 *
 * > | Unpublish | A `PUBLISHED → DRAFT` transition removes the row from
 * >   `article_fts` via the same trigger set |
 *
 * This file also discharges the half of SPEC-007's unpublish criterion that
 * DEC-036 transfers here: "TASK-007 must assert that an article unpublished by
 * SPEC-007's transition is absent from both the ranked feed and FTS results —
 * TASK-007 is not free to treat FTS as write-only."
 *
 * ── Every case here runs AFTER the index is installed, and that is the point ─
 * `ensureSearchIndex()` rebuilds the whole index on the install path, which
 * would mask a completely broken trigger set: install, then search, and the
 * results are perfect because `'rebuild'` recomputed them from the content
 * view. So `beforeAll` installs FIRST and every fixture article is written or
 * flipped AFTERWARDS. What is asserted below is therefore the trigger path and
 * nothing else. (Raised by the coordinator, MSG-2419, and it changed the shape
 * of this file.)
 *
 * ── Why `integrity-check` appears twice ──────────────────────────────────
 * `article_fts` is an EXTERNAL CONTENT table: a delete must restate the OLD
 * values (`INSERT INTO article_fts(article_fts, rowid, ...) VALUES('delete',
 * ...)`), and handing it values that do not byte-match what was indexed
 * corrupts the index WITHOUT raising anything. Missing the view's
 * `COALESCE(subtitle, '')` is enough to do it. Nothing in a search result
 * reveals that; FTS5's own `'integrity-check'` is the only thing that does, so
 * it runs after the flips and again after the delete.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb, getDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import {
  createArticle,
  deleteArticle,
  publishArticle,
  unpublishArticle,
  updateArticle,
} from '../../lib/db/articles';
import { getFeedPage } from '../../lib/feed/queries';
import {
  SEARCH_TRIGGER_NAMES,
  checkSearchIndexIntegrity,
  countIndexedArticles,
  ensureSearchIndex,
  searchArticles,
  searchTriggersInstalled,
} from '../../lib/search/fts';

const NOW = new Date('2026-08-01T00:00:00.000Z');

/** A title term that exists nowhere else. */
const TERM = 'platypus';

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

let db: TestDatabase;
let authorId = '';
let counter = 0;

/** A fresh DRAFT carrying the search term in its title. */
async function newDraft(term = TERM) {
  counter += 1;
  return createArticle({
    id: `a${String(counter).padStart(25, '0')}`,
    authorId,
    title: `The ${term} chronicles ${counter}`,
    subtitle: null,
    bodyJson: doc('A body with no distinctive words in it at all.'),
    bodyHtml: '<p>body</p>',
    status: 'DRAFT',
    now: NOW,
  });
}

/** Row ids currently in the index for a term, read from the index itself. */
async function indexedIdsFor(term: string): Promise<string[]> {
  const rows = await getDb().$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT a."id" AS "id"
       FROM "article_fts"
       JOIN "Article" a ON a."rowid" = "article_fts"."rowid"
      WHERE "article_fts" MATCH ?`,
    `"${term}"`,
  );
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  const author = await createUser({
    email: 'author@titan.test',
    passwordHash: 'x',
    handle: 'author',
    name: 'Author',
  });
  authorId = author.id;

  // Install BEFORE any fixture exists, so nothing below can be explained by
  // the install-path rebuild. See the module header.
  await ensureSearchIndex();
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

describe('SPEC-008 — installing the index', () => {
  it('creates all three triggers', async () => {
    expect(await searchTriggersInstalled()).toBe(true);
    expect(SEARCH_TRIGGER_NAMES).toHaveLength(3);
  });

  it('is idempotent — a second call installs nothing', async () => {
    expect(await ensureSearchIndex()).toBe(false);
    expect(await searchTriggersInstalled()).toBe(true);
  });
});

describe('SPEC-008 — publishing indexes, unpublishing removes', () => {
  it('does not index a draft', async () => {
    const draft = await newDraft();
    expect(await indexedIdsFor(TERM)).not.toContain(draft.id);
    expect(await searchArticles(TERM)).toEqual([]);
  });

  it('makes a published article findable by a title term', async () => {
    const draft = await newDraft();
    await publishArticle(draft.id, NOW);

    expect(await indexedIdsFor(TERM)).toContain(draft.id);
    expect((await searchArticles(TERM)).map((hit) => hit.id)).toContain(draft.id);
  });

  it('indexes it WITHIN THE SAME TRANSACTION as the status change', async () => {
    const draft = await newDraft('echidna');

    // The criterion says "within the same transaction", so the read happens
    // inside the transaction, before commit. A trigger is the only mechanism
    // that can satisfy this — an application-level reindex running after the
    // write would leave this read empty.
    await getDb().$transaction(async (tx) => {
      const before = await tx.$queryRawUnsafe<Array<{ n: number | bigint }>>(
        `SELECT COUNT(*) AS n FROM "article_fts" WHERE "article_fts" MATCH ?`,
        '"echidna"',
      );
      expect(Number(before[0]?.n ?? 0)).toBe(0);

      await tx.$executeRawUnsafe(
        `UPDATE "Article" SET "status" = 'PUBLISHED', "publishedAt" = ? WHERE "id" = ?`,
        NOW,
        draft.id,
      );

      const after = await tx.$queryRawUnsafe<Array<{ n: number | bigint }>>(
        `SELECT COUNT(*) AS n FROM "article_fts" WHERE "article_fts" MATCH ?`,
        '"echidna"',
      );
      expect(Number(after[0]?.n ?? 0)).toBe(1);
    });
  });

  it('removes it from search AND from the feed when it is unpublished', async () => {
    const draft = await newDraft();
    await publishArticle(draft.id, NOW);
    expect((await searchArticles(TERM)).map((hit) => hit.id)).toContain(draft.id);
    expect((await getFeedPage({ now: NOW, limit: 100 })).map((i) => i.id)).toContain(draft.id);

    await unpublishArticle(draft.id, NOW);

    // DEC-036: the feed-and-FTS half of SPEC-007's unpublish criterion.
    expect(await indexedIdsFor(TERM)).not.toContain(draft.id);
    expect((await searchArticles(TERM)).map((hit) => hit.id)).not.toContain(draft.id);
    expect((await getFeedPage({ now: NOW, limit: 100 })).map((i) => i.id)).not.toContain(draft.id);

    // And the row is still there — unpublishing hides, it does not delete.
    expect(await getDb().article.findUnique({ where: { id: draft.id } })).not.toBeNull();
  });

  it('survives a republish, so the transition is not one-way', async () => {
    const draft = await newDraft();
    await publishArticle(draft.id, NOW);
    await unpublishArticle(draft.id, NOW);
    await publishArticle(draft.id, NOW);

    expect(await indexedIdsFor(TERM)).toContain(draft.id);
  });
});

describe('SPEC-008 — edits to a published article', () => {
  it('re-indexes a changed title and drops the old one', async () => {
    const draft = await newDraft();
    await publishArticle(draft.id, NOW);
    expect(await indexedIdsFor(TERM)).toContain(draft.id);

    await updateArticle(draft.id, { title: 'Now about numbats instead', now: NOW });

    expect(await indexedIdsFor(TERM)).not.toContain(draft.id);
    expect(await indexedIdsFor('numbat')).toContain(draft.id);
  });

  it('keeps a published article indexed through an edit that changes nothing searchable', async () => {
    // The case that a two-trigger implementation gets wrong: with no defined
    // firing order, insert-then-delete on byte-identical values removes the
    // row that was just re-added, and the article silently disappears from
    // search because someone changed its cover image.
    const draft = await newDraft();
    await publishArticle(draft.id, NOW);

    await updateArticle(draft.id, { coverPath: '/uploads/covers/x.jpg', now: NOW });

    expect(await indexedIdsFor(TERM)).toContain(draft.id);
  });

  it('removes a deleted article from the index', async () => {
    const draft = await newDraft();
    await publishArticle(draft.id, NOW);
    const before = await countIndexedArticles();

    await deleteArticle(draft.id);

    expect(await indexedIdsFor(TERM)).not.toContain(draft.id);
    expect(await countIndexedArticles()).toBe(before - 1);
  });
});

describe('SPEC-008 — the index is not merely plausible, it is consistent', () => {
  beforeEach(async () => {
    await ensureSearchIndex();
  });

  it('passes FTS5 integrity-check after every transition above', async () => {
    // The only thing that catches a `'delete'` handed values that do not
    // byte-match what was indexed. A wrong COALESCE shows up here and nowhere
    // else until a reader gets a stale result.
    await expect(checkSearchIndexIntegrity()).resolves.toBeUndefined();
  });

  it('holds exactly the published rows', async () => {
    const published = await getDb().article.count({ where: { status: 'PUBLISHED' } });
    expect(await countIndexedArticles()).toBe(published);
  });
});
