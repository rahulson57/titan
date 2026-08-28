/**
 * Server-side authorization (SPEC-005, "Authorization rules").
 *
 * Sealed criterion: "A POST to the article-update action for an article owned
 * by another user returns a 403 and leaves the row unchanged."
 *
 * ── What is being tested, given the editor does not exist yet ──────────────
 * SPEC-007 owns the article-update action and is a later slice, so there is no
 * `updateArticleAction` to POST to. What TASK-004 owns is the sentence in its
 * own description: "the server-side authorization checks EVERY mutating action
 * calls" — `guardArticleMutation` in `lib/auth/session.ts`.
 *
 * So this suite exercises that guard wrapped around the REAL repository
 * writer, `updateArticle` from `lib/db/articles.ts`, against a REAL SQLite
 * row. That is exactly the composition SPEC-007's action will be, minus the
 * form parsing — which means "leaves the row unchanged" is checked by reading
 * the row back out of the database, not by asserting a mock was not called.
 *
 * The alternative — stubbing the mutation — would prove only that the guard
 * returns 403, and would say nothing about whether a write leaked past it.
 * That is the half of the criterion that matters.
 *
 * ── Why the guard takes a callback ─────────────────────────────────────────
 * A guard that answers yes/no can be checked and then ignored, and the
 * resulting bug is invisible in review because the check sits three lines
 * above the write that ignored it. Here the write is unreachable unless the
 * check passed, so "returns 403 AND leaves the row unchanged" is structural
 * rather than a discipline each of the six mutating actions has to maintain.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import {
  ARTICLE_STATUS,
  createArticle,
  getArticleById,
  updateArticle,
} from '../../lib/db/articles';
import {
  ForbiddenError,
  NotAuthenticatedError,
  NotVisibleError,
  type SessionUser,
  authorizationFor,
  canViewArticle,
  guardArticleMutation,
  ownsArticle,
  ownsProfile,
  ownsUploadPath,
  requireArticleOwner,
  requireProfileOwner,
  requireUser,
  requireVisibleArticle,
  toSessionUser,
} from '../../lib/auth/session';

const AT = new Date('2026-01-01T00:00:00.000Z');
const BODY = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text here.' }] }] };

let db: TestDatabase;
let author: SessionUser;
let stranger: SessionUser;
let draftId = '';
let publishedId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  author = toSessionUser(
    await createUser({
      email: 'author@titan.local',
      passwordHash: 'x',
      handle: 'author',
      name: 'Author',
      createdAt: AT,
    }),
  );
  stranger = toSessionUser(
    await createUser({
      email: 'stranger@titan.local',
      passwordHash: 'x',
      handle: 'stranger',
      name: 'Stranger',
      createdAt: AT,
    }),
  );

  draftId = (
    await createArticle({
      authorId: author.id,
      title: 'An unfinished thought',
      bodyJson: BODY,
      bodyHtml: '<p>Body text here.</p>',
      status: ARTICLE_STATUS.DRAFT,
      now: AT,
    })
  ).id;

  publishedId = (
    await createArticle({
      authorId: author.id,
      title: 'A finished thought',
      bodyJson: BODY,
      bodyHtml: '<p>Body text here.</p>',
      status: ARTICLE_STATUS.PUBLISHED,
      now: AT,
    })
  ).id;
});

/**
 * The composition SPEC-007's update action will be: load the row, decide, and
 * write only if the decision allowed it.
 */
function updateAs(user: SessionUser | null, articleId: string, title: string) {
  return guardArticleMutation(user, articleId, getArticleById, () =>
    updateArticle(articleId, { title, now: AT }),
  );
}

describe('SPEC-005 — only the author may edit an article', () => {
  it('rejects a signed-in stranger with 403 AND leaves the row unchanged', async () => {
    const before = await getArticleById(publishedId);

    const result = await updateAs(stranger, publishedId, 'Vandalised');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);

    // The half that actually matters: the row is byte-for-byte what it was.
    const after = await getArticleById(publishedId);
    expect(after?.title).toBe(before?.title);
    expect(after?.slug).toBe(before?.slug);
    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());
  });

  it('lets the author through and the write lands', async () => {
    const result = await updateAs(author, publishedId, 'A better title');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect((await getArticleById(publishedId))?.title).toBe('A better title');
  });

  it('rejects a stranger editing a DRAFT with 403 too — status does not change the answer', async () => {
    // SPEC-005's 404 rule is scoped to reading `/article/[slug]`, where a slug
    // is guessable. A mutation is addressed by article id — a 26-character
    // random cuid2 — so a caller holding one already knows the article exists
    // and 404 would hide a real permission error while buying no privacy.
    const result = await updateAs(stranger, draftId, 'Vandalised');

    expect(result.status).toBe(403);
    expect((await getArticleById(draftId))?.title).toBe('An unfinished thought');
  });

  it('rejects an anonymous write to a published article with 401', async () => {
    const result = await updateAs(null, publishedId, 'Vandalised');

    expect(result.status).toBe(401);
    expect((await getArticleById(publishedId))?.title).toBe('A finished thought');
  });

  it('rejects an anonymous write to a DRAFT with 401', async () => {
    // Same reasoning: an id cannot be reached by probing, so "sign in" is both
    // the honest answer and the actionable one.
    const result = await updateAs(null, draftId, 'Vandalised');
    expect(result.status).toBe(401);
  });

  it('returns 404 for an article that does not exist, without calling the mutation', async () => {
    let called = false;
    const result = await guardArticleMutation(author, 'nonexistent', getArticleById, async () => {
      called = true;
      return null;
    });

    expect(result.status).toBe(404);
    expect(called).toBe(false);
  });

  it('never invokes the mutation on a rejected call', async () => {
    // The structural property the callback shape exists to guarantee.
    for (const [user, id] of [
      [stranger, publishedId],
      [stranger, draftId],
      [null, publishedId],
      [null, draftId],
    ] as const) {
      let called = false;
      const result = await guardArticleMutation(user, id, getArticleById, async () => {
        called = true;
        return 'written';
      });
      expect(result.ok).toBe(false);
      expect(called, `mutation ran for status ${result.status}`).toBe(false);
    }
  });
});

describe('SPEC-005 — drafts are visible only to their author', () => {
  const draft = { authorId: 'author-id', status: 'DRAFT' };
  const published = { authorId: 'author-id', status: 'PUBLISHED' };
  const owner: SessionUser = { id: 'author-id', handle: 'a', name: 'A', avatarPath: null };
  const other: SessionUser = { id: 'other-id', handle: 'b', name: 'B', avatarPath: null };

  it('covers every (viewer, status) combination', () => {
    expect(canViewArticle(owner, draft)).toBe(true);
    expect(canViewArticle(other, draft)).toBe(false);
    expect(canViewArticle(null, draft)).toBe(false);

    expect(canViewArticle(owner, published)).toBe(true);
    expect(canViewArticle(other, published)).toBe(true);
    expect(canViewArticle(null, published)).toBe(true);
  });

  it('maps a draft read by anyone else to 404, never 403', () => {
    expect(authorizationFor(owner, draft, 'read')).toBe(200);
    expect(authorizationFor(other, draft, 'read')).toBe(404);
    expect(authorizationFor(null, draft, 'read')).toBe(404);
    expect(authorizationFor(null, published, 'read')).toBe(200);
  });

  it('ownsArticle is false for anonymous, regardless of the row', () => {
    expect(ownsArticle(null, draft)).toBe(false);
    expect(ownsArticle(owner, draft)).toBe(true);
    expect(ownsArticle(other, draft)).toBe(false);
  });
});

describe('SPEC-005 — the throwing wrappers carry the right status', () => {
  const draft = { authorId: 'author-id', status: 'DRAFT' };
  const published = { authorId: 'author-id', status: 'PUBLISHED' };
  const owner: SessionUser = { id: 'author-id', handle: 'a', name: 'A', avatarPath: null };
  const other: SessionUser = { id: 'other-id', handle: 'b', name: 'B', avatarPath: null };

  it('requireUser throws 401 with no session', () => {
    expect(() => requireUser(null)).toThrow(NotAuthenticatedError);
    expect(requireUser({ user: owner })).toBe(owner);
  });

  it('requireVisibleArticle throws 404 for a stranger and for a missing row', () => {
    expect(() => requireVisibleArticle(other, draft)).toThrow(NotVisibleError);
    expect(() => requireVisibleArticle(null, null)).toThrow(NotVisibleError);
    expect(requireVisibleArticle(owner, draft)).toBe(draft);
    expect(requireVisibleArticle(null, published)).toBe(published);
  });

  it('requireArticleOwner throws 403 for any signed-in stranger, 401 for anonymous', () => {
    expect(() => requireArticleOwner(other, published)).toThrow(ForbiddenError);
    expect(() => requireArticleOwner(other, draft)).toThrow(ForbiddenError);
    expect(() => requireArticleOwner(null, published)).toThrow(NotAuthenticatedError);
    expect(() => requireArticleOwner(null, draft)).toThrow(NotAuthenticatedError);
    expect(() => requireArticleOwner(owner, null)).toThrow(NotVisibleError);
    expect(requireArticleOwner(owner, draft)).toBe(draft);
  });

  it('exposes the HTTP status on the error itself', () => {
    // The mapping from rule to status code lives with the rule, so a route
    // handler cannot get it wrong by re-deciding at the call site.
    expect(new NotAuthenticatedError().status).toBe(401);
    expect(new ForbiddenError().status).toBe(403);
    expect(new NotVisibleError().status).toBe(404);
  });
});

describe('SPEC-005 — profile and upload ownership', () => {
  const owner: SessionUser = { id: 'user-1', handle: 'a', name: 'A', avatarPath: null };

  it('only the owning user may edit their profile', () => {
    expect(ownsProfile(owner, 'user-1')).toBe(true);
    expect(ownsProfile(owner, 'user-2')).toBe(false);
    expect(ownsProfile(null, 'user-1')).toBe(false);

    expect(requireProfileOwner(owner, 'user-1')).toBe(owner);
    expect(() => requireProfileOwner(owner, 'user-2')).toThrow(ForbiddenError);
    expect(() => requireProfileOwner(null, 'user-1')).toThrow(NotAuthenticatedError);
  });

  it('only the owning user may upload under their own path', () => {
    expect(ownsUploadPath(owner, 'public/uploads/user-1/avatar.webp')).toBe(true);
    expect(ownsUploadPath(owner, '/uploads/user-1/cover.webp')).toBe(true);
    expect(ownsUploadPath(owner, 'public/uploads/user-2/avatar.webp')).toBe(false);
    expect(ownsUploadPath(null, 'public/uploads/user-1/avatar.webp')).toBe(false);
  });

  it('rejects traversal that names another user and lands in your own directory', () => {
    // `startsWith` on the raw string would wave this through: the path claims
    // `user-2`'s segment while resolving inside `user-1`'s. Rejecting `..`
    // outright keeps the authorization decision and the filesystem's view of
    // the path from disagreeing.
    expect(ownsUploadPath(owner, 'public/uploads/user-2/../user-1/a.webp')).toBe(false);
    expect(ownsUploadPath(owner, 'public/uploads/user-1/../user-2/a.webp')).toBe(false);
    expect(ownsUploadPath(owner, 'public\\uploads\\user-2\\..\\user-1\\a.webp')).toBe(false);
  });

  it('rejects a path with no uploads segment at all', () => {
    expect(ownsUploadPath(owner, 'public/user-1/avatar.webp')).toBe(false);
    expect(ownsUploadPath(owner, '')).toBe(false);
  });
});

describe('toSessionUser narrows what a session can expose', () => {
  it('carries exactly the four fields SPEC-005 names, and no secrets', async () => {
    const user = await createUser({
      email: 'secret@titan.local',
      passwordHash: '$argon2id$this-must-never-escape',
      handle: 'secret_user',
      name: 'Secret',
      bio: 'a bio',
      createdAt: AT,
    });

    const session = toSessionUser(user);

    expect(Object.keys(session).sort()).toEqual(['avatarPath', 'handle', 'id', 'name']);
    // The reason the narrow type exists: this object crosses into server
    // components and from there into props that may be serialised to the
    // client. A `passwordHash` on it would ship in the HTML payload.
    expect(JSON.stringify(session)).not.toContain('argon2id');
    expect(JSON.stringify(session)).not.toContain('secret@titan.local');
  });
});
