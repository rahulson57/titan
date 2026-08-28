/**
 * The Article repository (SPEC-004).
 *
 * Consumed as `ArticleRepo` by Editor & Content (SPEC-007) and read by every
 * discovery and reading surface. What this module guarantees, and no caller has
 * to remember:
 *
 *  - `bodyHtml`, `bodyText` and `readingMinutes` are derived caches of
 *    `bodyJson` (DEC-002). `bodyText`/`readingMinutes` are recomputed HERE on
 *    every write via `lib/derive/reading.ts`, so the three columns cannot drift
 *    apart no matter which write path was taken. `bodyHtml` is generated from
 *    the closed ProseMirror schema, which is SPEC-007's to own, so it is passed
 *    in — but it is passed in on the SAME call that recomputes the other two.
 *  - `slug` is `kebab(title)-<6-char-suffix>` and is IMMUTABLE after first
 *    publish (SPEC-004). Retitling a published article does not move its URL.
 *  - `publishedAt` is set once, on the first DRAFT -> PUBLISHED transition, and
 *    is never touched again — including by a later unpublish/republish, which
 *    would otherwise let an old article jump to the top of a recency-weighted
 *    feed by being toggled.
 */

import type { Article, Prisma } from '@prisma/client';
import { getDb } from './client';
import { createId } from './ids';
import { deriveReading, type ProseMirrorNode } from '../derive/reading';

export type { Article };

export const ARTICLE_STATUS = { DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED' } as const;
export type ArticleStatus = (typeof ARTICLE_STATUS)[keyof typeof ARTICLE_STATUS];

/** SPEC-004: title 1-120 chars, subtitle at most 160. */
export const TITLE_MAX = 120;
export const SUBTITLE_MAX = 160;

/** An article with `bodyJson` already parsed out of its TEXT column. */
export type ArticleRecord = Omit<Article, 'bodyJson'> & { bodyJson: ProseMirrorNode };

export class ArticleNotFoundError extends Error {
  constructor(what: string) {
    super(`no article matching ${what}`);
    this.name = 'ArticleNotFoundError';
  }
}

export class InvalidStatusError extends Error {
  constructor(status: string) {
    super(`article status must be DRAFT or PUBLISHED, got ${JSON.stringify(status)}`);
    this.name = 'InvalidStatusError';
  }
}

/** SPEC-004's title is "1–120 chars"; this is the 1. */
export class EmptyTitleError extends Error {
  constructor() {
    super('article title must not be empty');
    this.name = 'EmptyTitleError';
  }
}

/**
 * Thrown when a write would move `bodyJson` without the matching `bodyHtml`.
 *
 * SPEC-004 lists `bodyHtml` as derived from `bodyJson` and "regenerated on
 * every save". `bodyText` and `readingMinutes` are recomputed here, so they
 * cannot drift — but `bodyHtml` needs SPEC-007's closed ProseMirror schema and
 * is therefore passed in. Without this guard the two halves come apart
 * silently: the article's text and read-time advance while the rendered HTML
 * the reading page actually serves stays on the previous revision, and nothing
 * fails. The type union below makes that unrepresentable for typed callers;
 * this error catches the untyped ones (a route handler forwarding parsed JSON).
 */
export class DerivedBodyMismatchError extends Error {
  constructor() {
    super('bodyJson and bodyHtml must be written together — bodyHtml is derived from bodyJson');
    this.name = 'DerivedBodyMismatchError';
  }
}

/**
 * Trim, then enforce SPEC-004's "title, 1–120 chars".
 *
 * Same split as `normalizeName`: over-long truncates, empty throws. Empty is
 * not merely untidy here — `buildSlug('')` yields `untitled-<suffix>`, so an
 * empty title silently mints a real, permanent URL for an article that has no
 * name, and the slug is frozen the moment it publishes.
 */
export function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new EmptyTitleError();
  return trimmed.slice(0, TITLE_MAX);
}

/**
 * `kebab(title)` — the human-readable half of a slug.
 *
 * Diacritics are folded through NFD rather than dropped so "Café" becomes
 * "cafe" and not "caf": a URL that silently loses a letter is worse than one
 * that transliterates.
 */
export function kebab(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * `kebab(title)-<6-char-suffix>` (SPEC-004).
 *
 * The suffix is what makes the slug unique without a retry loop against the
 * database, and it is derived from the article's own id so the same article
 * always produces the same slug — which is what lets the seed corpus be
 * deterministic. An untitled draft still gets a routable slug ("untitled-…"),
 * because a draft with no slug cannot be linked to from the editor.
 */
export function buildSlug(title: string, id: string): string {
  const base = kebab(title) || 'untitled';
  return `${base}-${id.slice(-6)}`;
}

function parseBody(raw: string): ProseMirrorNode {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProseMirrorNode;
    }
  } catch {
    /* fall through to the empty document below */
  }
  return { type: 'doc', content: [] };
}

function toRecord(row: Article): ArticleRecord {
  return { ...row, bodyJson: parseBody(row.bodyJson) };
}

function toRecordOrNull(row: Article | null): ArticleRecord | null {
  return row ? toRecord(row) : null;
}

function assertStatus(status: string): asserts status is ArticleStatus {
  if (status !== ARTICLE_STATUS.DRAFT && status !== ARTICLE_STATUS.PUBLISHED) {
    throw new InvalidStatusError(status);
  }
}

export interface WriteArticleInput {
  authorId: string;
  title: string;
  subtitle?: string | null;
  bodyJson: ProseMirrorNode;
  /** Generated from the closed schema by SPEC-007's `lib/content/render.ts`. */
  bodyHtml: string;
  coverPath?: string | null;
  status?: ArticleStatus;
  /** Injected so the seed corpus does not read a wall clock. */
  now?: Date;
  id?: string;
}

/** Create a new article. Defaults to DRAFT — publishing is a separate step. */
export async function createArticle(input: WriteArticleInput): Promise<ArticleRecord> {
  const status = input.status ?? ARTICLE_STATUS.DRAFT;
  assertStatus(status);

  const id = input.id ?? createId();
  const now = input.now ?? new Date();
  const title = normalizeTitle(input.title);
  const derived = deriveReading(input.bodyJson);

  const row = await getDb().article.create({
    data: {
      id,
      authorId: input.authorId,
      slug: buildSlug(title, id),
      title,
      subtitle: input.subtitle?.slice(0, SUBTITLE_MAX) ?? null,
      bodyJson: JSON.stringify(input.bodyJson),
      bodyHtml: input.bodyHtml,
      bodyText: derived.bodyText,
      coverPath: input.coverPath ?? null,
      readingMinutes: derived.readingMinutes,
      status,
      version: 1,
      publishedAt: status === ARTICLE_STATUS.PUBLISHED ? now : null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return toRecord(row);
}

interface UpdateArticleFields {
  title?: string;
  subtitle?: string | null;
  coverPath?: string | null;
  now?: Date;
}

/**
 * A patch either leaves the document alone or replaces it wholesale — there is
 * no third case in which `bodyJson` and `bodyHtml` move independently. Encoding
 * that as a union rather than two optional fields means the common mistake
 * (autosave sends the new doc, forgets the re-render) is a compile error at the
 * call site instead of a stale cache discovered on the reading page.
 */
export type UpdateArticleInput = UpdateArticleFields &
  (
    | { bodyJson: ProseMirrorNode; bodyHtml: string }
    | { bodyJson?: undefined; bodyHtml?: undefined }
  );

/**
 * The autosave write path. Bumps `version` on every save so SPEC-007's
 * optimistic-concurrency check has something to compare against, and re-derives
 * the caches whenever the document changed.
 *
 * The slug is recomputed from a new title ONLY while the article has never been
 * published; once `publishedAt` is set the URL is frozen (SPEC-004: "immutable
 * after first publish").
 */
export async function updateArticle(
  id: string,
  patch: UpdateArticleInput,
): Promise<ArticleRecord> {
  // Checked before the read: an ill-formed patch is a caller bug, and failing
  // on it should not depend on whether the article happens to exist.
  if ((patch.bodyJson === undefined) !== (patch.bodyHtml === undefined)) {
    throw new DerivedBodyMismatchError();
  }

  const existing = await getDb().article.findUnique({ where: { id } });
  if (!existing) throw new ArticleNotFoundError(`id ${id}`);

  const now = patch.now ?? new Date();
  const data: Prisma.ArticleUpdateInput = { updatedAt: now, version: { increment: 1 } };

  if (patch.title !== undefined) {
    const title = normalizeTitle(patch.title);
    data.title = title;
    if (existing.publishedAt === null) data.slug = buildSlug(title, existing.id);
  }
  if (patch.subtitle !== undefined) {
    data.subtitle = patch.subtitle === null ? null : patch.subtitle.slice(0, SUBTITLE_MAX);
  }
  if (patch.coverPath !== undefined) data.coverPath = patch.coverPath;
  if (patch.bodyHtml !== undefined) data.bodyHtml = patch.bodyHtml;
  if (patch.bodyJson !== undefined) {
    const derived = deriveReading(patch.bodyJson);
    data.bodyJson = JSON.stringify(patch.bodyJson);
    data.bodyText = derived.bodyText;
    data.readingMinutes = derived.readingMinutes;
  }

  return toRecord(await getDb().article.update({ where: { id }, data }));
}

/** DRAFT -> PUBLISHED. `publishedAt` is stamped only the first time. */
export async function publishArticle(id: string, now: Date = new Date()): Promise<ArticleRecord> {
  const existing = await getDb().article.findUnique({ where: { id } });
  if (!existing) throw new ArticleNotFoundError(`id ${id}`);

  return toRecord(
    await getDb().article.update({
      where: { id },
      data: {
        status: ARTICLE_STATUS.PUBLISHED,
        publishedAt: existing.publishedAt ?? now,
        updatedAt: now,
        version: { increment: 1 },
      },
    }),
  );
}

/**
 * PUBLISHED -> DRAFT. `publishedAt` is deliberately left in place: it records
 * when the article first went public, which is still true, and clearing it
 * would un-freeze the slug and let a republish mint a new URL for an article
 * people already have links to.
 */
export async function unpublishArticle(id: string, now: Date = new Date()): Promise<ArticleRecord> {
  return toRecord(
    await getDb().article.update({
      where: { id },
      data: { status: ARTICLE_STATUS.DRAFT, updatedAt: now, version: { increment: 1 } },
    }),
  );
}

export async function getArticleById(id: string): Promise<ArticleRecord | null> {
  return toRecordOrNull(await getDb().article.findUnique({ where: { id } }));
}

/** Slug is the only public article identifier (SPEC-009). */
export async function getArticleBySlug(slug: string): Promise<ArticleRecord | null> {
  return toRecordOrNull(await getDb().article.findUnique({ where: { slug } }));
}

export async function deleteArticle(id: string): Promise<void> {
  await getDb().article.delete({ where: { id } });
}

/** `COUNT(*)` of an author's articles in one status — the profile tab counts. */
export async function countArticlesByAuthor(
  authorId: string,
  status: ArticleStatus = ARTICLE_STATUS.PUBLISHED,
): Promise<number> {
  return getDb().article.count({ where: { authorId, status } });
}
