/**
 * The publish state machine's guards (SPEC-007).
 *
 * Two sealed criteria:
 *
 * > Publishing with an empty title, or `bodyText` < 50 chars, or 0 tags, or 6
 * > tags is rejected with a field-level error and the row stays `DRAFT`.
 *
 * > First publish sets a unique `slug` and `publishedAt`; a subsequent
 * > edit-and-republish leaves both byte-identical.
 *
 * ── "and the row stays DRAFT" is the load-bearing clause ───────────────────
 * Returning an error object is the easy half. Every rejection test below reads
 * the row back afterwards and asserts four things did not move: `status`,
 * `publishedAt`, `version` and the tag set. A "publish, then roll back on
 * failure" implementation satisfies the letter of the criterion — the row IS
 * `DRAFT` when you look — while having bumped `version`, which makes the
 * author's next autosave collide with a save nobody performed. So the
 * assertion is not "it ended up DRAFT" but "nothing was written at all".
 *
 * ── Boundaries are tested at the boundary ──────────────────────────────────
 * 49 characters and 50. Zero tags, one, five and six. A guard tested at 10 and
 * 100 characters is a guard whose `<` versus `<=` is unverified, and that is
 * the only part of it anyone ever gets wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { ARTICLE_STATUS, createArticle, getArticleById } from '../../lib/db/articles';
import { listTagsForArticle } from '../../lib/db/tags';
import {
  MAX_TAGS,
  MIN_BODY_TEXT_CHARS,
  MIN_TAGS,
  canPublish,
  deleteDraft,
  normalizeTagList,
  publishDraft,
  saveDraftContent,
  unpublishDraft,
  validatePublish,
} from '../../lib/content/publish';
import { MAX_TAGS_PER_ARTICLE } from '../../lib/db/tags';

const AT = new Date('2026-06-01T09:00:00.000Z');
const LATER = new Date('2026-06-02T09:00:00.000Z');

/** A document whose `bodyText` is exactly `length` characters. */
function bodyOf(length: number) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(length) }] }],
  };
}

/** A realistic body, comfortably over the floor. */
const LONG_BODY = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'A paragraph long enough to clear the fifty-character floor with room to spare.',
        },
      ],
    },
  ],
};

let db: TestDatabase;
let authorId = '';
let articleId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
}, 120_000);

afterAll(async () => {
  await disconnectDb();
  await db.drop();
});

beforeEach(async () => {
  await db.client.$executeRawUnsafe('DELETE FROM "ArticleTag"');
  await db.client.$executeRawUnsafe('DELETE FROM "Tag"');
  await db.client.$executeRawUnsafe('DELETE FROM "Article"');
  await db.client.$executeRawUnsafe('DELETE FROM "User"');

  const author = await createUser({
    email: 'author@titan.local',
    passwordHash: 'x',
    handle: 'author',
    name: 'The Author',
    createdAt: AT,
  });
  authorId = author.id;

  const article = await createArticle({
    authorId,
    title: 'A finished piece',
    bodyJson: LONG_BODY,
    bodyHtml: '<p>...</p>',
    now: AT,
  });
  articleId = article.id;
});

/** The four columns a rejected publish must leave untouched. */
async function snapshot() {
  const row = await getArticleById(articleId);
  return {
    status: row?.status,
    publishedAt: row?.publishedAt?.toISOString() ?? null,
    version: row?.version,
    slug: row?.slug,
    tags: (await listTagsForArticle(articleId)).map((tag) => tag.slug).sort(),
  };
}

// ---------------------------------------------------------------------------
// The pure guard
// ---------------------------------------------------------------------------

describe('SPEC-007 — validatePublish, at the boundaries', () => {
  const VALID = { title: 'A title', bodyText: 'x'.repeat(MIN_BODY_TEXT_CHARS), tags: ['craft'] };

  it('accepts the minimum viable article', () => {
    expect(validatePublish(VALID)).toEqual([]);
    expect(canPublish(VALID)).toBe(true);
  });

  it('uses the numbers the spec fixes', () => {
    expect(MIN_BODY_TEXT_CHARS).toBe(50);
    expect(MIN_TAGS).toBe(1);
    expect(MAX_TAGS).toBe(5);
  });

  it('agrees with the ceiling the repository actually enforces', () => {
    // `MAX_TAGS` is a literal in `lib/content/autosave.ts` rather than a
    // re-export of `MAX_TAGS_PER_ARTICLE`, because that module is imported by a
    // CLIENT component and `lib/db/tags.ts` imports the generated Prisma
    // client — the re-export would drag the repository layer, and
    // `node:crypto` under it, into the browser bundle.
    //
    // A duplicated constant is a real hazard, so it is held together here
    // rather than by inspection: a test file is bundled by nobody, so it can
    // import both sides. If SPEC-004's ceiling ever moves, this fails before
    // the form and the repository can disagree in front of an author.
    expect(MAX_TAGS).toBe(MAX_TAGS_PER_ARTICLE);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n\t '],
  ])('rejects a %s title against the title field', (_label, title) => {
    const errors = validatePublish({ ...VALID, title });
    expect(errors.map((e) => e.field)).toEqual(['title']);
    expect(errors[0]?.message).toBeTruthy();
  });

  it('rejects 49 characters and accepts 50', () => {
    // The one comparison anyone gets wrong. `< 50` versus `<= 50` is
    // indistinguishable at any other pair of values.
    expect(validatePublish({ ...VALID, bodyText: 'x'.repeat(49) }).map((e) => e.field)).toEqual([
      'body',
    ]);
    expect(validatePublish({ ...VALID, bodyText: 'x'.repeat(50) })).toEqual([]);
  });

  it('measures the body after trimming', () => {
    // 50 characters of which 40 are spaces is not an article. Counting raw
    // length would let a document of whitespace publish.
    const padded = `${' '.repeat(40)}${'x'.repeat(10)}${' '.repeat(40)}`;
    expect(padded.length).toBeGreaterThan(MIN_BODY_TEXT_CHARS);
    expect(validatePublish({ ...VALID, bodyText: padded }).map((e) => e.field)).toEqual(['body']);
  });

  it('rejects 0 tags and accepts 1', () => {
    expect(validatePublish({ ...VALID, tags: [] }).map((e) => e.field)).toEqual(['tags']);
    expect(validatePublish({ ...VALID, tags: ['one'] })).toEqual([]);
  });

  it('accepts 5 tags and rejects 6', () => {
    const five = ['one', 'two', 'three', 'four', 'five'];
    expect(validatePublish({ ...VALID, tags: five })).toEqual([]);
    expect(validatePublish({ ...VALID, tags: [...five, 'six'] }).map((e) => e.field)).toEqual([
      'tags',
    ]);
  });

  it('reports every problem at once, not the first', () => {
    // SPEC-007's oracle asks for "a field-level error"; a form that reveals its
    // next problem only after you fix the current one is a form the author
    // submits three times. Same posture as `validateSignUp` in SPEC-005.
    const errors = validatePublish({ title: '', bodyText: 'short', tags: [] });
    expect(errors.map((e) => e.field).sort()).toEqual(['body', 'tags', 'title']);
  });

  it('counts tags the way the repository stores them', () => {
    // `setArticleTags` deduplicates by slug, so six entries that collapse to
    // five ARE five. A guard counting the raw list would reject an article the
    // repository would happily have stored — and, worse, a guard counting five
    // duplicates as five would pass validation and then store one tag.
    expect(normalizeTagList(['craft', 'Craft', ' craft ', '', '  '])).toEqual(['craft']);
    expect(validatePublish({ ...VALID, tags: ['a', 'b', 'c', 'd', 'e', 'E'] })).toEqual([]);
    expect(validatePublish({ ...VALID, tags: ['   ', ''] }).map((e) => e.field)).toEqual(['tags']);
  });

  it('preserves the first spelling of a duplicated tag', () => {
    // The display name matters: a tag first created through this path would
    // otherwise be labelled by whichever casing happened to arrive last.
    expect(normalizeTagList(['Design Systems', 'design systems'])).toEqual(['Design Systems']);
  });
});

// ---------------------------------------------------------------------------
// Rejection leaves the row alone
// ---------------------------------------------------------------------------

describe('SPEC-007 — a rejected publish writes nothing', () => {
  it.each([
    ['an empty title', { title: '', tags: ['craft'] }, 'title'],
    ['no tags', { tags: [] }, 'tags'],
    ['six tags', { tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'tags'],
  ])('refuses %s with a field-level error and leaves the row DRAFT', async (_l, input, field) => {
    const before = await snapshot();

    const result = await publishDraft(articleId, input, LATER);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.errors.map((e) => e.field)).toContain(field);
    }
    expect(await snapshot()).toEqual(before);
    expect(before.status).toBe(ARTICLE_STATUS.DRAFT);
  });

  it('refuses a body under 50 characters and leaves the row DRAFT', async () => {
    // Set up through the real save path rather than by writing the column, so
    // `bodyText` is the value `lib/derive/reading.ts` actually derives.
    await saveDraftContent(articleId, {
      title: 'A finished piece',
      bodyJson: bodyOf(49),
      version: 1,
    });
    const before = await snapshot();
    expect((await getArticleById(articleId))?.bodyText).toHaveLength(49);

    const result = await publishDraft(articleId, { tags: ['craft'] }, LATER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toEqual(['body']);
    expect(await snapshot()).toEqual(before);
  });

  it('publishes at exactly 50 characters', async () => {
    // The control for the case above. Without it, "always refuse" would pass.
    await saveDraftContent(articleId, {
      title: 'A finished piece',
      bodyJson: bodyOf(50),
      version: 1,
    });

    const result = await publishDraft(articleId, { tags: ['craft'] }, LATER);
    expect(result.ok).toBe(true);
    expect((await getArticleById(articleId))?.status).toBe(ARTICLE_STATUS.PUBLISHED);
  });

  it('does not bump version on a rejected publish', async () => {
    // Stated separately because it is the assertion that distinguishes
    // "validated first" from "published then rolled back". A bumped version
    // would make the author's next autosave return 409 against a save that
    // never happened.
    const before = await getArticleById(articleId);
    await publishDraft(articleId, { tags: [] }, LATER);
    const after = await getArticleById(articleId);

    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());
  });

  it('does not replace the tag set on a rejected publish', async () => {
    await publishDraft(articleId, { tags: ['keeper'] }, AT);
    await unpublishDraft(articleId, AT);
    const before = await snapshot();
    expect(before.tags).toEqual(['keeper']);

    // Six tags: rejected. The existing set must survive intact — a publish that
    // wrote the tags before validating would have emptied it.
    await publishDraft(articleId, { tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, LATER);
    expect((await snapshot()).tags).toEqual(['keeper']);
  });

  it('404s for an article that no longer exists', async () => {
    const result = await publishDraft('a00000000000000000000000x', { tags: ['craft'] }, LATER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// slug and publishedAt
// ---------------------------------------------------------------------------

describe('SPEC-007 — the slug and publishedAt are set once and never move', () => {
  it('stamps publishedAt and a unique slug on the first publish', async () => {
    const before = await getArticleById(articleId);
    expect(before?.publishedAt).toBeNull();

    const result = await publishDraft(articleId, { tags: ['craft'] }, LATER);
    expect(result.ok).toBe(true);

    const after = await getArticleById(articleId);
    expect(after?.status).toBe(ARTICLE_STATUS.PUBLISHED);
    expect(after?.publishedAt?.toISOString()).toBe(LATER.toISOString());

    // Unique by construction: `kebab(title)-<6 chars of the id>` (SPEC-004).
    expect(after?.slug).toMatch(/^a-finished-piece-[0-9a-z]{6}$/);
    expect(after?.slug.endsWith(articleId.slice(-6))).toBe(true);
  });

  it('leaves both byte-identical after an edit and a republish', async () => {
    await publishDraft(articleId, { tags: ['craft'] }, LATER);
    const first = await getArticleById(articleId);

    // A real edit, through the real save path, INCLUDING a new title — the case
    // that would move the slug if `updateArticle`'s freeze were not holding.
    const saved = await saveDraftContent(
      articleId,
      {
        title: 'A completely different title',
        bodyJson: LONG_BODY,
        version: first?.version ?? 1,
      },
      new Date('2026-06-03T09:00:00.000Z'),
    );
    expect(saved.ok).toBe(true);

    await publishDraft(
      articleId,
      { title: 'A completely different title', tags: ['craft'] },
      new Date('2026-06-04T09:00:00.000Z'),
    );

    const second = await getArticleById(articleId);
    expect(second?.title).toBe('A completely different title');
    // Byte-identical, both of them. The URL people already hold does not move,
    // and the article does not jump to the top of a recency-ranked feed.
    expect(second?.slug).toBe(first?.slug);
    expect(second?.publishedAt?.toISOString()).toBe(first?.publishedAt?.toISOString());
  });

  it('tracks the title in the slug right up until the first publish', async () => {
    // The other half of the freeze, and the reason the title is applied BEFORE
    // `publishArticle` rather than after: an article renamed while still a
    // draft must publish at the URL its final title implies, not at the one its
    // working title did.
    const saved = await saveDraftContent(articleId, {
      title: 'The title it ended up with',
      bodyJson: LONG_BODY,
      version: 1,
    });
    expect(saved.ok).toBe(true);

    await publishDraft(
      articleId,
      { title: 'The title it ended up with', tags: ['craft'] },
      LATER,
    );
    expect((await getArticleById(articleId))?.slug).toMatch(/^the-title-it-ended-up-with-/);
  });

  it('does not move publishedAt across an unpublish and a republish', async () => {
    await publishDraft(articleId, { tags: ['craft'] }, LATER);
    const firstPublish = (await getArticleById(articleId))?.publishedAt?.toISOString();

    await unpublishDraft(articleId, new Date('2026-06-05T09:00:00.000Z'));
    await publishDraft(articleId, { tags: ['craft'] }, new Date('2026-06-06T09:00:00.000Z'));

    // Otherwise toggling an old article off and on again would let it jump to
    // the top of a recency-weighted feed — a free promotion for anyone who
    // notices.
    expect((await getArticleById(articleId))?.publishedAt?.toISOString()).toBe(firstPublish);
  });
});

// ---------------------------------------------------------------------------
// The rest of the machine
// ---------------------------------------------------------------------------

describe('SPEC-007 — the remaining transitions', () => {
  it('unpublishes back to DRAFT while keeping the row, slug and publishedAt', async () => {
    await publishDraft(articleId, { tags: ['craft'] }, LATER);
    const published = await getArticleById(articleId);

    const result = await unpublishDraft(articleId, new Date('2026-06-07T09:00:00.000Z'));
    expect(result.ok).toBe(true);

    const after = await getArticleById(articleId);
    expect(after).not.toBeNull();
    expect(after?.status).toBe(ARTICLE_STATUS.DRAFT);
    expect(after?.slug).toBe(published?.slug);
    expect(after?.publishedAt?.toISOString()).toBe(published?.publishedAt?.toISOString());
  });

  it('treats unpublishing a draft as a no-op rather than an error', async () => {
    const before = await snapshot();
    const result = await unpublishDraft(articleId, LATER);

    expect(result.ok).toBe(true);
    // Idempotent, and idempotent WITHOUT a write: a double-click on the
    // unpublish control must not bump `version` the second time.
    expect(await snapshot()).toEqual(before);
  });

  it('carries the tag set through to the published article', async () => {
    await publishDraft(articleId, { tags: ['Design Systems', 'craft'] }, LATER);
    expect((await snapshot()).tags).toEqual(['craft', 'design-systems']);
  });

  it('keeps the tags already attached when a publish names none', async () => {
    // `input.tags` is optional; omitting it means "publish what is attached",
    // not "publish with no tags". If it meant the latter, the publish action
    // would strip an article's tags every time it was called without them.
    await publishDraft(articleId, { tags: ['craft'] }, LATER);
    await unpublishDraft(articleId, LATER);

    const result = await publishDraft(articleId, {}, LATER);
    expect(result.ok).toBe(true);
    expect((await snapshot()).tags).toEqual(['craft']);
  });

  it('deletes the row, and reports what it deleted', async () => {
    await publishDraft(articleId, { tags: ['craft'] }, LATER);
    const result = await deleteDraft(articleId);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.articleId).toBe(articleId);
    expect(await getArticleById(articleId)).toBeNull();

    // Cascaded, per SPEC-004 — the join rows go with the article rather than
    // becoming orphans that break the tag pages.
    const rows = await db.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT COUNT(*) AS n FROM "ArticleTag"',
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('404s rather than throwing when deleting something already gone', async () => {
    await deleteDraft(articleId);
    const again = await deleteDraft(articleId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(404);
  });
});
