/**
 * Draft privacy on the discovery surfaces (SPEC-008).
 *
 * > Zero DRAFT articles appear in `/`, `/tag/[slug]`, or `/search` for any
 * > viewer including their own author.
 *
 * ── "Including their own author" is the whole test ────────────────────────
 * A draft filter is easy to get right for strangers and easy to get wrong for
 * the author, because "show me my own work" is a reasonable-sounding rule that
 * someone will eventually add to a feed query. It is the wrong rule HERE:
 * these are discovery surfaces, not a library. An author's unfinished draft
 * appearing in their own home feed — between other people's published work,
 * with a link a reader could be handed in a screenshot — is a privacy defect
 * that the author is the last person to notice, because to them it looks like
 * a feature.
 *
 * So every assertion below runs twice: once for a stranger, once for the
 * author of the drafts. SPEC-005 owns the article page's own 404 for a
 * non-author; this file owns the LISTS, which is where a draft leaks silently
 * rather than loudly.
 *
 * ── Why the FTS index is checked as well as the search function ───────────
 * `searchArticles` re-checks `status = 'PUBLISHED'` on the join, so it would
 * hide a draft even if the index contained one. That belt-and-braces is right
 * for the product and wrong for the test: it would let a genuinely broken
 * trigger — one that indexes drafts — pass unnoticed until something else
 * queried the index. The last case here reads the index directly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb, getDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle, publishArticle, unpublishArticle } from '../../lib/db/articles';
import { setArticleTags } from '../../lib/db/tags';
import { follow } from '../../lib/db/social';
import { getFeedPage, getFollowingPage, getTagPage, getPopularTags } from '../../lib/feed/queries';
import { ensureSearchIndex, searchArticles } from '../../lib/search/fts';

const NOW = new Date('2026-04-01T00:00:00.000Z');

/** A word that appears in every fixture article, draft and published alike. */
const SHARED_TERM = 'quokka';

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function articleIdFor(index: number): string {
  return `a${String(index).padStart(25, '0')}`;
}

const PUBLISHED_IDS = [articleIdFor(1), articleIdFor(2)];
const DRAFT_IDS = [articleIdFor(51), articleIdFor(52)];
/** Published, then unpublished — the transition SPEC-007 owns, seen from here. */
const RETRACTED_ID = articleIdFor(60);

let db: TestDatabase;
let authorId = '';
let strangerId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;

  const author = await createUser({
    email: 'author@titan.test',
    passwordHash: 'x',
    handle: 'author',
    name: 'Author',
  });
  const stranger = await createUser({
    email: 'stranger@titan.test',
    passwordHash: 'x',
    handle: 'stranger',
    name: 'Stranger',
  });
  authorId = author.id;
  strangerId = stranger.id;

  // Both viewers follow the author, so the Following tab has something to
  // show and the draft filter is the only thing that can hide a draft.
  await follow(strangerId, authorId, NOW);

  for (const [index, id] of [...PUBLISHED_IDS, ...DRAFT_IDS, RETRACTED_ID].entries()) {
    const isDraft = DRAFT_IDS.includes(id);
    await createArticle({
      id,
      authorId,
      title: `${SHARED_TERM} story ${index}`,
      subtitle: `about the ${SHARED_TERM}`,
      bodyJson: doc(`Everything here mentions the ${SHARED_TERM} at least once.`),
      bodyHtml: '<p>body</p>',
      status: isDraft ? 'DRAFT' : 'PUBLISHED',
      now: NOW,
    });
    await setArticleTags(id, ['marsupials']);
  }

  // The retracted one goes PUBLISHED -> DRAFT after the index exists, which is
  // the path DEC-036 hands this slice from TASK-006.
  await ensureSearchIndex();
  await publishArticle(RETRACTED_ID, NOW);
  await unpublishArticle(RETRACTED_ID, NOW);
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

/** Every id that must never appear on a discovery surface. */
const HIDDEN = [...DRAFT_IDS, RETRACTED_ID];

describe.each([
  ['a stranger', () => strangerId],
  ['the author of the drafts', () => authorId],
])('SPEC-008 — no DRAFT reaches a discovery surface, viewed by %s', (_label, viewer) => {
  it('is absent from the For-you feed', async () => {
    const page = await getFeedPage({ now: NOW, limit: 100 });
    const ids = page.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(PUBLISHED_IDS));
    for (const hidden of HIDDEN) expect(ids).not.toContain(hidden);
  });

  it('is absent from the Following tab', async () => {
    // The author follows nobody, so their own Following tab is empty either
    // way; the stranger follows the author and sees only published work.
    // Asserted for both, because "empty" and "filtered" must both hold.
    const page = await getFollowingPage({ viewerId: viewer(), now: NOW, limit: 100 });
    for (const hidden of HIDDEN) {
      expect(page.map((item) => item.id)).not.toContain(hidden);
    }
  });

  it('is absent from the tag page', async () => {
    const page = await getTagPage({ slug: 'marsupials', now: NOW, limit: 100 });
    const ids = page.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(PUBLISHED_IDS));
    for (const hidden of HIDDEN) expect(ids).not.toContain(hidden);
  });

  it('is absent from search results', async () => {
    const hits = await searchArticles(SHARED_TERM, { limit: 100 });
    const ids = hits.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(PUBLISHED_IDS));
    for (const hidden of HIDDEN) expect(ids).not.toContain(hidden);
  });
});

describe('SPEC-008 — the index itself holds no drafts', () => {
  it('never indexed the drafts, so nothing downstream has to filter them', async () => {
    await ensureSearchIndex();
    const rows = await getDb().$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT a."id" AS "id"
         FROM "article_fts"
         JOIN "Article" a ON a."rowid" = "article_fts"."rowid"
        WHERE "article_fts" MATCH ?`,
      `"${SHARED_TERM}"`,
    );
    const ids = rows.map((row) => row.id);
    expect(ids.sort()).toEqual([...PUBLISHED_IDS].sort());
  });

  it('counts only published articles when ranking popular tags', async () => {
    const [tag] = await getPopularTags();
    // Five articles carry `marsupials`; two are published, two are drafts and
    // one was retracted. A count of 5 would mean drafts are steering a public
    // affordance.
    expect(tag?.slug).toBe('marsupials');
    expect(tag?.articleCount).toBe(PUBLISHED_IDS.length);
  });
});
