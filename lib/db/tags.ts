/**
 * The Tag / ArticleTag repository (SPEC-004).
 *
 * The rule this module exists to enforce is the five-tag ceiling:
 *
 * > **ArticleTag** | articleId + tagId | composite @id | max 5 tags per article
 *
 * SQLite cannot express "at most five rows sharing a column" — there is no
 * partial-count constraint — so the ceiling has to live in code. Putting it
 * here rather than in the editor's form validation is the point: a Server
 * Action, a seed script and a future import path would each need their own copy
 * of the check, and the first one to forget it would silently create a
 * six-tagged article that renders wrong on the tag pages.
 * `tests/unit/repo-tag.test.ts` proves the 6th attachment is refused.
 */

import type { Tag } from '@prisma/client';
import { getDb } from './client';
import { createId } from './ids';

export type { Tag };

/** SPEC-004: max 5 tags per article. */
export const MAX_TAGS_PER_ARTICLE = 5;

/** SPEC-004: tag slug is `^[a-z0-9-]{2,32}$`. */
export const TAG_SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;

export class TooManyTagsError extends Error {
  readonly limit = MAX_TAGS_PER_ARTICLE;
  constructor(articleId: string) {
    super(`article ${articleId} already has ${MAX_TAGS_PER_ARTICLE} tags`);
    this.name = 'TooManyTagsError';
  }
}

export class InvalidTagSlugError extends Error {
  constructor(slug: string) {
    super(`tag slug ${JSON.stringify(slug)} does not match ${TAG_SLUG_PATTERN}`);
    this.name = 'InvalidTagSlugError';
  }
}

/** Fold a display name or a typed slug into the canonical slug form. */
export function normalizeTagSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  if (!TAG_SLUG_PATTERN.test(slug)) throw new InvalidTagSlugError(input);
  return slug;
}

/**
 * Find-or-create by slug. Two articles published in the same second with the
 * same new tag would otherwise race to insert it, so this goes through
 * `upsert` on the unique slug rather than a read-then-write.
 */
export async function upsertTag(name: string, id?: string): Promise<Tag> {
  const slug = normalizeTagSlug(name);
  return getDb().tag.upsert({
    where: { slug },
    update: {},
    create: { id: id ?? createId(), slug, name: name.trim() },
  });
}

export async function findTagBySlug(slug: string): Promise<Tag | null> {
  return getDb().tag.findUnique({ where: { slug } });
}

export async function listTagsForArticle(articleId: string): Promise<Tag[]> {
  const rows = await getDb().articleTag.findMany({
    where: { articleId },
    include: { tag: true },
    orderBy: { tagId: 'asc' },
  });
  return rows.map((row) => row.tag);
}

export async function countTagsForArticle(articleId: string): Promise<number> {
  return getDb().articleTag.count({ where: { articleId } });
}

/**
 * Attach one tag to an article, refusing the 6th.
 *
 * Re-attaching a tag the article already has is a no-op rather than an error,
 * and — importantly — does NOT count against the ceiling: the check is on the
 * resulting set size, not on the number of calls, so a form that submits the
 * same five tags twice does not fail on the sixth submit.
 */
export async function attachTag(articleId: string, tagName: string): Promise<Tag> {
  const tag = await upsertTag(tagName);

  const existing = await getDb().articleTag.findUnique({
    where: { articleId_tagId: { articleId, tagId: tag.id } },
  });
  if (existing) return tag;

  if ((await countTagsForArticle(articleId)) >= MAX_TAGS_PER_ARTICLE) {
    throw new TooManyTagsError(articleId);
  }

  await getDb().articleTag.create({ data: { articleId, tagId: tag.id } });
  return tag;
}

export async function detachTag(articleId: string, tagId: string): Promise<void> {
  await getDb().articleTag.deleteMany({ where: { articleId, tagId } });
}

/**
 * Replace an article's whole tag set in one call — the shape the editor
 * actually saves in.
 *
 * The ceiling is checked against the incoming list BEFORE anything is written,
 * so an over-long list leaves the article's existing tags untouched instead of
 * half-applying and throwing partway through.
 */
export async function setArticleTags(articleId: string, tagNames: string[]): Promise<Tag[]> {
  // Deduplicate by slug but keep the ORIGINAL name for each survivor. Passing
  // the slug to `upsertTag` instead would mean a tag first created through this
  // path is displayed as "design-systems" while the same tag created through
  // `attachTag` is displayed as "Design Systems" — one tag, two labels,
  // depending on which write path happened to reach it first.
  const bySlug = new Map<string, string>();
  for (const name of tagNames) {
    const slug = normalizeTagSlug(name);
    if (!bySlug.has(slug)) bySlug.set(slug, name);
  }
  if (bySlug.size > MAX_TAGS_PER_ARTICLE) throw new TooManyTagsError(articleId);

  const tags: Tag[] = [];
  for (const name of bySlug.values()) tags.push(await upsertTag(name));

  await getDb().articleTag.deleteMany({ where: { articleId } });
  if (tags.length > 0) {
    await getDb().articleTag.createMany({
      data: tags.map((tag) => ({ articleId, tagId: tag.id })),
    });
  }
  return tags;
}
