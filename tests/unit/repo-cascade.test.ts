/**
 * Referential integrity, and the article/user write paths that depend on it
 * (SPEC-004).
 *
 * > Deleting a User cascades to their Articles, Claps, Bookmarks, Follows and
 * > Sessions leaving zero orphan rows.
 *
 * The cascade is a SCHEMA property (`onDelete: Cascade`), not a loop in the
 * repository, and the difference matters: a loop is a list somebody has to keep
 * complete, and the row type it forgets is the one nobody notices. So the test
 * deletes a user and then counts every table that could hold a reference,
 * rather than asserting that a particular delete method was called.
 *
 * ── Why the article and session write paths are also here ───────────────────
 * This slice's file scope fixes the set of test files; there is no
 * `repo-article.test.ts` to write. The article lifecycle assertions belong with
 * this fixture anyway — they need the same author/article/engagement graph, and
 * the slug-immutability rule is only observable across a state transition.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import {
  BIO_MAX,
  EmptyNameError,
  InvalidHandleError,
  NAME_MAX,
  UserNotFoundError,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  deleteUser,
  findSessionUser,
  findUserByEmail,
  findUserByHandle,
  findUserById,
  isValidSocial,
  normalizeEmail,
  normalizeHandle,
  parseSocials,
  serializeSocials,
  updateUser,
} from '../../lib/db/users';
import {
  ARTICLE_STATUS,
  ArticleNotFoundError,
  DerivedBodyMismatchError,
  EmptyTitleError,
  InvalidStatusError,
  buildSlug,
  countArticlesByAuthor,
  createArticle,
  deleteArticle,
  getArticleById,
  getArticleBySlug,
  kebab,
  publishArticle,
  unpublishArticle,
  updateArticle,
  type UpdateArticleInput,
} from '../../lib/db/articles';
import { setClap, toggleBookmark, follow } from '../../lib/db/social';
import { attachTag } from '../../lib/db/tags';

const AT = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-02-01T00:00:00.000Z');

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  for (const table of ['Clap', 'Bookmark', 'Follow', 'ArticleTag', 'Article', 'Tag', 'Session', 'User']) {
    await db.client.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
});

async function makeUser(handle: string) {
  return createUser({
    email: `${handle}@titan.local`,
    passwordHash: 'x',
    handle,
    name: handle,
    createdAt: AT,
  });
}

async function count(table: string): Promise<number> {
  const [row] = await db.client.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*) AS n FROM "${table}"`,
  );
  return Number(row?.n ?? 0);
}

describe('SPEC-004 — deleting a user leaves zero orphan rows', () => {
  it('cascades to articles, claps, bookmarks, follows and sessions', async () => {
    const victim = await makeUser('victim');
    const survivor = await makeUser('survivor');

    const article = await createArticle({
      authorId: victim.id,
      title: 'Doomed',
      bodyJson: doc('body'),
      bodyHtml: '<p>body</p>',
      status: ARTICLE_STATUS.PUBLISHED,
      now: AT,
    });
    const kept = await createArticle({
      authorId: survivor.id,
      title: 'Kept',
      bodyJson: doc('body'),
      bodyHtml: '<p>body</p>',
      status: ARTICLE_STATUS.PUBLISHED,
      now: AT,
    });

    await attachTag(article.id, 'design');
    // Every direction the victim can be referenced from:
    await setClap(victim.id, kept.id, 5, AT); //   as a clapper
    await setClap(survivor.id, article.id, 5, AT); // on their article
    await toggleBookmark(victim.id, kept.id, AT); // as a bookmarker
    await toggleBookmark(survivor.id, article.id, AT); // of their article
    await follow(victim.id, survivor.id, AT); //   as a follower
    await follow(survivor.id, victim.id, AT); //   as a followee
    await createSession({ userId: victim.id, expiresAt: LATER, createdAt: AT });
    await createSession({ userId: survivor.id, expiresAt: LATER, createdAt: AT });

    await deleteUser(victim.id);

    // The victim's own row and everything hanging off it, in both directions.
    expect(await count('User')).toBe(1);
    expect(await count('Article')).toBe(1);
    expect(await count('ArticleTag')).toBe(0); // went with the article
    expect(await count('Clap')).toBe(0); // one by them, one on their article
    expect(await count('Bookmark')).toBe(0);
    expect(await count('Follow')).toBe(0);
    expect(await count('Session')).toBe(1);

    // And nothing that belonged to the survivor was taken with it.
    expect(await getArticleById(kept.id)).not.toBeNull();
  });

  it('leaves no row referencing a missing user or article', async () => {
    const author = await makeUser('author');
    const reader = await makeUser('reader');
    const article = await createArticle({
      authorId: author.id,
      title: 'Referenced',
      bodyJson: doc('body'),
      bodyHtml: '',
      now: AT,
    });
    await setClap(reader.id, article.id, 3, AT);
    await toggleBookmark(reader.id, article.id, AT);

    await deleteUser(author.id);

    // A dangling-reference sweep rather than a count: this is the assertion
    // that would still fail if a future migration dropped a cascade.
    const orphans = await db.client.$queryRawUnsafe<Array<{ n: bigint }>>(`
      SELECT (
        (SELECT COUNT(*) FROM "Article"  a LEFT JOIN "User"    u ON u.id = a.authorId  WHERE u.id IS NULL) +
        (SELECT COUNT(*) FROM "Clap"     c LEFT JOIN "Article" a ON a.id = c.articleId WHERE a.id IS NULL) +
        (SELECT COUNT(*) FROM "Clap"     c LEFT JOIN "User"    u ON u.id = c.userId    WHERE u.id IS NULL) +
        (SELECT COUNT(*) FROM "Bookmark" b LEFT JOIN "Article" a ON a.id = b.articleId WHERE a.id IS NULL) +
        (SELECT COUNT(*) FROM "Bookmark" b LEFT JOIN "User"    u ON u.id = b.userId    WHERE u.id IS NULL) +
        (SELECT COUNT(*) FROM "Session"  s LEFT JOIN "User"    u ON u.id = s.userId    WHERE u.id IS NULL) +
        (SELECT COUNT(*) FROM "ArticleTag" t LEFT JOIN "Article" a ON a.id = t.articleId WHERE a.id IS NULL)
      ) AS n
    `);
    expect(Number(orphans[0]?.n)).toBe(0);
  });

  it('cascades from an article without touching its author', async () => {
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 'Deleted directly',
      bodyJson: doc('body'),
      bodyHtml: '',
      now: AT,
    });
    await attachTag(article.id, 'design');
    await setClap(author.id, article.id, 2, AT);

    await deleteArticle(article.id);

    expect(await count('Article')).toBe(0);
    expect(await count('ArticleTag')).toBe(0);
    expect(await count('Clap')).toBe(0);
    expect(await count('Tag')).toBe(1); // the tag itself outlives the article
    expect(await findUserById(author.id)).not.toBeNull();
  });
});

describe('SPEC-004 — user normalisation happens on the way in, not at the call site', () => {
  it('stores email lowercased so uniqueness is decided on the normalised form', async () => {
    const user = await createUser({
      email: '  Demo@Titan.Local ',
      passwordHash: 'x',
      handle: 'Demo',
      name: 'Demo',
      createdAt: AT,
    });
    expect(user.email).toBe('demo@titan.local');
    expect(user.handle).toBe('demo');
    expect(await findUserByEmail('DEMO@TITAN.LOCAL')).not.toBeNull();
  });

  it('resolves a handle with or without the leading @ from a pasted URL', async () => {
    await makeUser('reader');
    expect((await findUserByHandle('@Reader'))?.handle).toBe('reader');
    expect(await findUserByHandle('nobody')).toBeNull();
    expect(await findUserByHandle('!!')).toBeNull(); // unroutable, not a throw
  });

  it('refuses a handle outside `^[a-z0-9_]{3,24}$`', () => {
    expect(() => normalizeHandle('ab')).toThrow(InvalidHandleError);
    expect(() => normalizeHandle('has spaces')).toThrow(InvalidHandleError);
    expect(() => normalizeHandle('x'.repeat(25))).toThrow(InvalidHandleError);
    expect(normalizeHandle(' Valid_Handle9 ')).toBe('valid_handle9');
    expect(normalizeEmail(' A@B.C ')).toBe('a@b.c');
  });

  it('clamps name and bio to their documented lengths rather than storing over-long text', async () => {
    const user = await createUser({
      email: 'long@titan.local',
      passwordHash: 'x',
      handle: 'long',
      name: 'n'.repeat(200),
      bio: 'b'.repeat(500),
      createdAt: AT,
    });
    expect(user.name).toHaveLength(NAME_MAX);
    expect(user.bio).toHaveLength(BIO_MAX);
  });

  it('round-trips socials through the TEXT column, dropping empties', async () => {
    const user = await createUser({
      email: 'social@titan.local',
      passwordHash: 'x',
      handle: 'social',
      name: 'Social',
      socials: { twitter: ' handle ', github: '', website: 'https://example.test' },
      createdAt: AT,
    });
    expect(user.socials).toEqual({ twitter: 'handle', website: 'https://example.test' });

    const patched = await updateUser(user.id, { socials: {}, bio: null, name: 'Renamed' });
    expect(patched.socials).toEqual({});
    expect(patched.bio).toBeNull();
    expect(patched.name).toBe('Renamed');
  });

  it('degrades a corrupt socials column to no links instead of throwing', () => {
    // The column is TEXT, so nothing at the database level stops a bad write.
    // A profile page must still render.
    expect(parseSocials('not json')).toEqual({});
    expect(parseSocials('[1,2]')).toEqual({});
    expect(parseSocials(null)).toEqual({});
    expect(serializeSocials(null)).toBe('{}');
  });

  it('refuses an empty display name — the "1" in SPEC-004\'s "1-60 chars"', async () => {
    await expect(
      createUser({ email: 'e@t.local', passwordHash: 'x', handle: 'empty', name: '   ' }),
    ).rejects.toThrow(EmptyNameError);

    const user = await makeUser('named');
    await expect(updateUser(user.id, { name: '' })).rejects.toThrow(EmptyNameError);
    expect((await findUserById(user.id))?.name).toBe(user.name);
  });

  it('drops a social link that is neither a handle nor an http(s) URL', () => {
    // The load-bearing case: these render as `href`s on a public profile, so a
    // `javascript:` value accepted here is stored XSS that no view can undo.
    expect(isValidSocial('javascript:alert(1)')).toBe(false);
    expect(isValidSocial('data:text/html,<script>')).toBe(false);
    expect(isValidSocial('  ')).toBe(false);
    expect(isValidSocial('not a handle')).toBe(false);
    expect(isValidSocial('@ada')).toBe(true);
    expect(isValidSocial('ada-lovelace')).toBe(true);
    expect(isValidSocial('https://example.test/ada')).toBe(true);
    expect(isValidSocial('http://example.test')).toBe(true);

    expect(
      serializeSocials({ twitter: 'javascript:alert(1)', website: 'https://example.test' }),
    ).toBe(JSON.stringify({ website: 'https://example.test' }));
  });

  it('names its own error type for a missing user', () => {
    expect(new UserNotFoundError('id x').name).toBe('UserNotFoundError');
  });
});

describe('SPEC-005 — sessions live here, expiry is decided by an injected clock', () => {
  it('resolves a live session to its user', async () => {
    const user = await makeUser('session');
    const session = await createSession({ userId: user.id, expiresAt: LATER, createdAt: AT });
    expect((await findSessionUser(session.id, AT))?.id).toBe(user.id);
  });

  it('treats an expired session as absent without deleting it', async () => {
    // Sign-out is what revokes; reaping on read would make "the row is gone"
    // ambiguous in SPEC-005's assertions.
    const user = await makeUser('expired');
    const session = await createSession({ userId: user.id, expiresAt: AT, createdAt: AT });
    expect(await findSessionUser(session.id, LATER)).toBeNull();
    expect(await count('Session')).toBe(1);
  });

  it('returns null for an unknown session id', async () => {
    expect(await findSessionUser('nope', AT)).toBeNull();
  });

  it('deletes one session, and sweeps expired ones on demand', async () => {
    const user = await makeUser('sweep');
    const live = await createSession({ userId: user.id, expiresAt: LATER, createdAt: AT });
    await createSession({ userId: user.id, expiresAt: AT, createdAt: AT });

    // Swept at AT: the row expiring exactly at AT is gone (`expiresAt <= now`),
    // the one expiring at LATER is not.
    expect(await deleteExpiredSessions(AT)).toBe(1);
    expect(await count('Session')).toBe(1);

    await deleteSession(live.id);
    await deleteSession(live.id); // idempotent
    expect(await count('Session')).toBe(0);
  });
});

describe('SPEC-004 — the article write paths keep derived columns and the slug honest', () => {
  it('derives bodyText and readingMinutes on create, from bodyJson alone', async () => {
    const author = await makeUser('author');
    const body = Array.from({ length: 500 }, () => 'word').join(' ');
    const article = await createArticle({
      authorId: author.id,
      title: 'Derived on write',
      bodyJson: doc(body),
      bodyHtml: `<p>${body}</p>`,
      now: AT,
    });
    expect(article.bodyText).toBe(body);
    expect(article.readingMinutes).toBe(Math.ceil(500 / 238));
    expect(article.status).toBe(ARTICLE_STATUS.DRAFT); // publishing is a separate step
    expect(article.publishedAt).toBeNull();
    expect(article.version).toBe(1);
  });

  it('re-derives them on every body update, so the three columns cannot drift', async () => {
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 'Short',
      bodyJson: doc('one two three'),
      bodyHtml: '',
      now: AT,
    });
    const longer = Array.from({ length: 1_000 }, () => 'word').join(' ');
    const updated = await updateArticle(article.id, {
      bodyJson: doc(longer),
      bodyHtml: `<p>${longer}</p>`,
      now: LATER,
    });
    expect(updated.bodyText).toBe(longer);
    expect(updated.readingMinutes).toBe(Math.ceil(1_000 / 238));
    expect(updated.version).toBe(2); // optimistic-concurrency counter advanced
  });

  it('builds `kebab(title)-<6-char-suffix>` and keeps it unique per article', async () => {
    expect(kebab('Café — Design Systems!')).toBe('cafe-design-systems');
    expect(kebab('!!!')).toBe('');
    expect(buildSlug('!!!', 'abcdefghij')).toBe('untitled-efghij');
    expect(buildSlug('Hello World', 'abcdefghij')).toBe('hello-world-efghij');
  });

  it('lets a draft slug follow its title, and freezes it at first publish', async () => {
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 'First title',
      bodyJson: doc('body'),
      bodyHtml: '',
      now: AT,
    });
    const renamed = await updateArticle(article.id, { title: 'Second title', now: AT });
    expect(renamed.slug).toBe(buildSlug('Second title', article.id));

    const published = await publishArticle(article.id, LATER);
    const retitled = await updateArticle(article.id, { title: 'Third title', now: LATER });
    expect(retitled.slug, 'a published URL must not move under its readers').toBe(published.slug);
    expect(await getArticleBySlug(published.slug)).not.toBeNull();
  });

  it('stamps publishedAt once and never again', async () => {
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 'Published once',
      bodyJson: doc('body'),
      bodyHtml: '',
      now: AT,
    });

    const first = await publishArticle(article.id, LATER);
    expect(first.publishedAt?.toISOString()).toBe(LATER.toISOString());

    // Unpublish/republish must not re-date the article — otherwise toggling it
    // is a way to jump a recency-weighted feed.
    await unpublishArticle(article.id, LATER);
    const again = await publishArticle(article.id, new Date('2026-06-01T00:00:00.000Z'));
    expect(again.publishedAt?.toISOString()).toBe(LATER.toISOString());
    expect(again.status).toBe(ARTICLE_STATUS.PUBLISHED);
  });

  it('counts an author’s articles by status for the profile tabs', async () => {
    const author = await makeUser('author');
    for (const [title, status] of [
      ['One', ARTICLE_STATUS.PUBLISHED],
      ['Two', ARTICLE_STATUS.PUBLISHED],
      ['Three', ARTICLE_STATUS.DRAFT],
    ] as const) {
      await createArticle({
        authorId: author.id,
        title,
        bodyJson: doc('body'),
        bodyHtml: '',
        status,
        now: AT,
      });
    }
    expect(await countArticlesByAuthor(author.id)).toBe(2);
    expect(await countArticlesByAuthor(author.id, ARTICLE_STATUS.DRAFT)).toBe(1);
  });

  it('refuses a status outside the two SQLite cannot constrain', async () => {
    const author = await makeUser('author');
    await expect(
      createArticle({
        authorId: author.id,
        title: 'Bad status',
        bodyJson: doc('body'),
        bodyHtml: '',
        status: 'ARCHIVED' as never,
        now: AT,
      }),
    ).rejects.toBeInstanceOf(InvalidStatusError);
  });

  it('names its own error when the article is not there', async () => {
    await expect(updateArticle('missing', { title: 'x', now: AT })).rejects.toBeInstanceOf(
      ArticleNotFoundError,
    );
    await expect(publishArticle('missing', AT)).rejects.toBeInstanceOf(ArticleNotFoundError);
    expect(await getArticleById('missing')).toBeNull();
    expect(await getArticleBySlug('missing')).toBeNull();
  });

  it('survives a corrupt bodyJson column with an empty document', async () => {
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 'Corrupt',
      bodyJson: doc('body'),
      bodyHtml: '',
      now: AT,
    });
    await db.client.$executeRawUnsafe(
      'UPDATE "Article" SET bodyJson = ? WHERE id = ?',
      'not json',
      article.id,
    );
    expect((await getArticleById(article.id))?.bodyJson).toEqual({ type: 'doc', content: [] });
  });

  it('clamps title and subtitle, and clears a subtitle when set to null', async () => {
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 't'.repeat(300),
      subtitle: 's'.repeat(300),
      bodyJson: doc('body'),
      bodyHtml: '',
      coverPath: '/uploads/covers/x.webp',
      now: AT,
    });
    expect(article.title).toHaveLength(120);
    expect(article.subtitle).toHaveLength(160);

    const cleared = await updateArticle(article.id, {
      subtitle: null,
      coverPath: null,
      bodyJson: doc('x'),
      bodyHtml: '<p>x</p>',
      now: AT,
    });
    expect(cleared.subtitle).toBeNull();
    expect(cleared.coverPath).toBeNull();
    expect(cleared.bodyHtml).toBe('<p>x</p>');
  });

  it('refuses a title that is empty or only whitespace, rather than minting `untitled-…`', async () => {
    const author = await makeUser('author');
    await expect(
      createArticle({ authorId: author.id, title: '   ', bodyJson: doc('body'), bodyHtml: '' }),
    ).rejects.toThrow(EmptyTitleError);

    const article = await createArticle({
      authorId: author.id,
      title: 'Real title',
      bodyJson: doc('body'),
      bodyHtml: '',
      now: AT,
    });
    await expect(updateArticle(article.id, { title: '' })).rejects.toThrow(EmptyTitleError);
  });

  it('will not let bodyJson move without the bodyHtml derived from it', async () => {
    // The type union makes this a compile error for typed callers; the runtime
    // guard is for the untyped ones, so it has to be asserted through a cast.
    const author = await makeUser('author');
    const article = await createArticle({
      authorId: author.id,
      title: 'Drift',
      bodyJson: doc('before'),
      bodyHtml: '<p>before</p>',
      now: AT,
    });

    const bodyOnly = { bodyJson: doc('after') } as unknown as UpdateArticleInput;
    await expect(updateArticle(article.id, bodyOnly)).rejects.toThrow(DerivedBodyMismatchError);

    const htmlOnly = { bodyHtml: '<p>after</p>' } as unknown as UpdateArticleInput;
    await expect(updateArticle(article.id, htmlOnly)).rejects.toThrow(DerivedBodyMismatchError);

    // Rejected before the row is read, so a bad patch cannot half-apply.
    const unchanged = await getArticleById(article.id);
    expect(unchanged?.bodyText).toBe('before');
    expect(unchanged?.bodyHtml).toBe('<p>before</p>');
    expect(unchanged?.version).toBe(1);
  });
});
