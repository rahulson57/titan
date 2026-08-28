/**
 * The bookmark rule (SPEC-009), against a real database.
 *
 * The sealed criterion:
 *
 *   > "`bookmark` invoked twice on the same article returns `{bookmarked:true}`
 *   >  then `{bookmarked:false}` and leaves zero rows."
 *
 * Both halves matter and only one of them is visible from a browser. "Returns
 * true then false" is about the VALUE the optimistic UI rolls back onto;
 * "leaves zero rows" is about the database. `lib/engage/bookmark.ts` takes the
 * viewer as a parameter so this suite can assert both in the same test — see
 * `tests/unit/engage-clap.test.ts` for why the Server Action itself cannot be
 * imported here.
 *
 * This suite is about the ENGAGEMENT layer: authorization, the returned shape,
 * and the draft rule. The repository's own contract — the cursor, the
 * tiebreak, the page size — is `tests/unit/repo-bookmark.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { toSessionUser, type SessionUser } from '../../lib/auth/session';
import { ARTICLE_STATUS, createArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import { countBookmarks, isBookmarked } from '../../lib/db/social';
import { createUser } from '../../lib/db/users';
import { applyBookmark, readBookmarkState } from '../../lib/engage/bookmark';

const AT = new Date('2026-01-01T00:00:00.000Z');

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Worth saving for later.' }] }],
};

let db: TestDatabase;
let reader: SessionUser;
let author: SessionUser;
let articleId = '';
let otherArticleId = '';
let draftId = '';

async function makeUser(handle: string): Promise<SessionUser> {
  return toSessionUser(
    await createUser({
      email: `${handle}@titan.local`,
      passwordHash: 'x',
      handle,
      name: handle.toUpperCase(),
      createdAt: AT,
    }),
  );
}

async function makeArticle(title: string, status: 'DRAFT' | 'PUBLISHED'): Promise<string> {
  const article = await createArticle({
    authorId: author.id,
    title,
    bodyJson: DOC,
    bodyHtml: '<p>Worth saving for later.</p>',
    status,
    now: AT,
  });
  return article.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  await db.client.$executeRawUnsafe('DELETE FROM "Bookmark"');
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  author = await makeUser('bmauthor');
  reader = await makeUser('bmreader');

  articleId = await makeArticle('A story worth saving', ARTICLE_STATUS.PUBLISHED);
  otherArticleId = await makeArticle('Another story', ARTICLE_STATUS.PUBLISHED);
  draftId = await makeArticle('Still a draft', ARTICLE_STATUS.DRAFT);
});

describe('SPEC-009 — bookmark is an idempotent toggle', () => {
  it('returns {bookmarked:true} then {bookmarked:false} and leaves zero rows', async () => {
    const first = await applyBookmark(reader, articleId, AT);
    expect(first).toEqual({ ok: true, status: 200, value: { bookmarked: true } });
    expect(await countBookmarks(reader.id)).toBe(1);

    const second = await applyBookmark(reader, articleId, AT);
    expect(second).toEqual({ ok: true, status: 200, value: { bookmarked: false } });
    expect(await countBookmarks(reader.id)).toBe(0);
  });

  it('keeps returning the state it LEFT, not the state it found, across four taps', async () => {
    // The returned value is what the optimistic control rolls back onto, so it
    // has to describe where the toggle ended up. A function that reported the
    // previous state would be off by one flip on every call and the control
    // would settle inverted.
    const states: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await applyBookmark(reader, articleId, AT);
      if (result.ok) states.push(result.value.bookmarked);
    }
    expect(states).toEqual([true, false, true, false]);
    expect(await countBookmarks(reader.id)).toBe(0);
  });

  it('scopes the toggle to one article — saving one does not save the other', async () => {
    await applyBookmark(reader, articleId, AT);

    expect(await isBookmarked(reader.id, articleId)).toBe(true);
    expect(await isBookmarked(reader.id, otherArticleId)).toBe(false);
    expect(await countBookmarks(reader.id)).toBe(1);
  });

  it('takes the owner from the viewer, so there is no parameter to forge', async () => {
    // `applyBookmark` has no userId argument at all — the row it writes can
    // only belong to the caller. This asserts that structurally: the author,
    // who never called it, has nothing.
    await applyBookmark(reader, articleId, AT);

    expect(await countBookmarks(reader.id)).toBe(1);
    expect(await countBookmarks(author.id)).toBe(0);
  });
});

describe('SPEC-009 — readBookmarkState renders the control before any mutation', () => {
  it('is false for a reader who has not saved it, and true once they have', async () => {
    expect(await readBookmarkState(reader, articleId)).toEqual({ bookmarked: false });
    await applyBookmark(reader, articleId, AT);
    expect(await readBookmarkState(reader, articleId)).toEqual({ bookmarked: true });
  });

  it('is false for an anonymous reader rather than an error', async () => {
    // The signed-out control still has to render — it routes to /signin, it
    // does not fail. Only the mutation is 401.
    expect(await readBookmarkState(null, articleId)).toEqual({ bookmarked: false });
  });
});

describe('SPEC-005 — a bookmark attempt cannot discover a draft', () => {
  it('answers 404 for someone else’s draft and writes nothing', async () => {
    const result = await applyBookmark(reader, draftId, AT);

    expect(result).toEqual({ ok: false, status: 404, error: 'Not found.' });
    expect(await countBookmarks(reader.id)).toBe(0);
  });

  it('gives the identical 404 for an article that does not exist', async () => {
    expect(await applyBookmark(reader, 'no-such-article', AT)).toEqual({
      ok: false,
      status: 404,
      error: 'Not found.',
    });
  });

  it('lets the author save their own draft', async () => {
    expect((await applyBookmark(author, draftId, AT)).ok).toBe(true);
    expect(await isBookmarked(author.id, draftId)).toBe(true);
  });
});
