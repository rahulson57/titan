/**
 * The five-tag ceiling (SPEC-004).
 *
 * > Attaching a 6th tag to an article is rejected with `TooManyTagsError`.
 *
 * SQLite cannot express "at most five rows sharing a column", so this rule
 * lives in `lib/db/tags.ts` and nowhere else. The tests below cover both shapes
 * the editor can reach it through — one-at-a-time attachment and a whole-set
 * replace — because a ceiling enforced on only one of them is a ceiling that
 * holds until somebody uses the other path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { disconnectDb } from '../../lib/db/client';
import { createUser } from '../../lib/db/users';
import { createArticle } from '../../lib/db/articles';
import {
  InvalidTagSlugError,
  MAX_TAGS_PER_ARTICLE,
  TooManyTagsError,
  attachTag,
  countTagsForArticle,
  detachTag,
  findTagBySlug,
  listTagsForArticle,
  normalizeTagSlug,
  setArticleTags,
  upsertTag,
} from '../../lib/db/tags';

const AT = new Date('2026-01-01T00:00:00.000Z');
const SIX = ['design', 'systems', 'writing', 'craft', 'process', 'tools'];

let db: TestDatabase;
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
    name: 'Author',
    createdAt: AT,
  });
  articleId = (
    await createArticle({
      authorId: author.id,
      title: 'A tagged article',
      bodyJson: { type: 'doc', content: [] },
      bodyHtml: '',
      now: AT,
    })
  ).id;
});

describe('SPEC-004 — an article may carry at most five tags', () => {
  it('accepts five and rejects the sixth with TooManyTagsError', async () => {
    for (const name of SIX.slice(0, MAX_TAGS_PER_ARTICLE)) await attachTag(articleId, name);
    expect(await countTagsForArticle(articleId)).toBe(5);

    await expect(attachTag(articleId, SIX[5]!)).rejects.toBeInstanceOf(TooManyTagsError);
    expect(await countTagsForArticle(articleId)).toBe(5);
  });

  it('rejects an over-long set without half-applying it', async () => {
    await setArticleTags(articleId, ['design', 'systems']);
    await expect(setArticleTags(articleId, SIX)).rejects.toBeInstanceOf(TooManyTagsError);

    // The pre-existing tags survive: the ceiling is checked before any write.
    const remaining = (await listTagsForArticle(articleId)).map((t) => t.slug).sort();
    expect(remaining).toEqual(['design', 'systems']);
  });

  it('counts the resulting SET, not the number of calls', async () => {
    // Re-submitting the same five tags is what a form does on every save. If
    // the ceiling counted calls, the second save of an unchanged article would
    // fail — a bug that only shows up on the sixth edit.
    for (const name of SIX.slice(0, 5)) await attachTag(articleId, name);
    for (const name of SIX.slice(0, 5)) await attachTag(articleId, name);
    expect(await countTagsForArticle(articleId)).toBe(5);
  });

  it('frees a slot when a tag is detached', async () => {
    for (const name of SIX.slice(0, 5)) await attachTag(articleId, name);
    const first = (await listTagsForArticle(articleId))[0]!;
    await detachTag(articleId, first.id);
    await expect(attachTag(articleId, SIX[5]!)).resolves.toBeDefined();
    expect(await countTagsForArticle(articleId)).toBe(5);
  });

  it('exposes the limit on the error, so a caller can say "5" without hardcoding it', async () => {
    for (const name of SIX.slice(0, 5)) await attachTag(articleId, name);
    await attachTag(articleId, SIX[5]!).catch((error: unknown) => {
      expect((error as TooManyTagsError).limit).toBe(MAX_TAGS_PER_ARTICLE);
    });
  });
});

describe('SPEC-004 — tag slugs are canonical', () => {
  it('folds display text into `^[a-z0-9-]{2,32}$`', () => {
    expect(normalizeTagSlug('Design Systems')).toBe('design-systems');
    expect(normalizeTagSlug('  Web   Perf!  ')).toBe('web-perf');
    expect(normalizeTagSlug('TESTING')).toBe('testing');
  });

  it('refuses input that cannot become a valid slug', () => {
    expect(() => normalizeTagSlug('!')).toThrow(InvalidTagSlugError);
    expect(() => normalizeTagSlug('')).toThrow(InvalidTagSlugError);
    expect(() => normalizeTagSlug('a')).toThrow(InvalidTagSlugError);
  });

  it('finds-or-creates rather than duplicating on a second use', async () => {
    const first = await upsertTag('Design Systems');
    const second = await upsertTag('design systems');
    expect(second.id).toBe(first.id);
    expect((await findTagBySlug('design-systems'))?.id).toBe(first.id);
    expect(await findTagBySlug('nothing-here')).toBeNull();
  });

  it('deduplicates within one set rather than spending two of the five slots', async () => {
    const tags = await setArticleTags(articleId, ['Design', 'design', 'DESIGN']);
    expect(tags).toHaveLength(1);
    expect(await countTagsForArticle(articleId)).toBe(1);
  });

  it('replaces the whole set, dropping tags that are no longer listed', async () => {
    await setArticleTags(articleId, ['design', 'systems']);
    await setArticleTags(articleId, ['writing']);
    expect((await listTagsForArticle(articleId)).map((t) => t.slug)).toEqual(['writing']);
  });

  it('accepts an empty set — an article may carry no tags at all', async () => {
    await setArticleTags(articleId, ['design']);
    await setArticleTags(articleId, []);
    expect(await listTagsForArticle(articleId)).toEqual([]);
  });

  it('stores the display name, not the slug, so both write paths agree on the label', async () => {
    // Regression: this path used to hand the normalized slug to `upsertTag`, so
    // a tag first created here read "design-systems" while the same tag created
    // via `attachTag` read "Design Systems". One tag, two labels, decided by
    // whichever write happened to be first.
    const set = await setArticleTags(articleId, ['Design Systems']);
    expect(set).toHaveLength(1);
    expect(set[0]?.slug).toBe('design-systems');
    expect(set[0]?.name).toBe('Design Systems');

    const viaAttach = await attachTag(articleId, 'Design Systems');
    expect(viaAttach.id).toBe(set[0]?.id);
    expect(viaAttach.name).toBe('Design Systems');
  });

  it('keeps the first spelling when a set repeats one tag in different cases', async () => {
    const tags = await setArticleTags(articleId, ['Design', 'design']);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.name).toBe('Design');
  });
});
