/**
 * The publish state machine (SPEC-007).
 *
 * | Transition                     | Guard                                       | Effect                                              |
 * |--------------------------------|---------------------------------------------|-----------------------------------------------------|
 * | `DRAFT -> PUBLISHED`           | title non-empty, `bodyText` >= 50, 1-5 tags | sets `slug` (first time only), `publishedAt = now`  |
 * | `PUBLISHED -> PUBLISHED` (edit)| author only                                 | updates row; `slug` and `publishedAt` unchanged      |
 * | `PUBLISHED -> DRAFT`           | author only                                 | leaves the feed; `publishedAt` and `slug` retained   |
 * | delete                         | author only                                 | hard delete, cascades per Persistence               |
 *
 * ── The guards are a pure function, and that is the point ──────────────────
 * `validatePublish` takes three plain values and returns field errors. It
 * touches no database, so `tests/unit/publish-guards.test.ts` can enumerate the
 * boundary — 49 characters versus 50, zero tags versus one, five versus six —
 * exhaustively and in milliseconds. `publishDraft` then calls it BEFORE it
 * writes anything, which is what makes "the row stays `DRAFT`" true by
 * construction rather than by a rollback.
 *
 * ── What this module deliberately does NOT do: FTS ─────────────────────────
 * SPEC-007 says publishing "indexes into FTS" and unpublishing "removes from
 * FTS + feed". Nothing here writes to `article_fts`, and that is not an
 * omission. The initial migration says so in its own comment — "the write
 * TRIGGERS that keep this in step with `Article` are owned by SPEC-008 (Feed &
 * Search)" — and Feed & Search is TASK-007, a later slice, explicitly out of
 * scope for this task.
 *
 * The design that makes that a clean seam rather than a gap: the triggers key
 * off `Article.status`, so publishing correctly here IS indexing, the moment
 * those triggers exist. Writing the index by hand from this module would give
 * the search corpus two authors that must agree — the failure mode being an
 * article that is published but unfindable, or findable but unpublished. The
 * FTS half of the publish-flow criterion is therefore asserted by
 * `tests/e2e/publish-flow.spec.ts` behind a capability guard that names
 * TASK-007, in the same shape `tests/e2e/draft-privacy.spec.ts` uses.
 */

import {
  ARTICLE_STATUS,
  type ArticleRecord,
  type ArticleStatus,
  deleteArticle,
  getArticleById,
  publishArticle,
  unpublishArticle,
  updateArticle,
} from '../db/articles';
import { MAX_TAGS_PER_ARTICLE, TooManyTagsError, listTagsForArticle, setArticleTags } from '../db/tags';
import { deriveContent } from './render';

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/** SPEC-007: "`bodyText` >= 50 chars". */
export const MIN_BODY_TEXT_CHARS = 50;

/** SPEC-007: "1-5 tags". The ceiling is SPEC-004's, re-exported so there is one number. */
export const MIN_TAGS = 1;
export const MAX_TAGS = MAX_TAGS_PER_ARTICLE;

export type PublishField = 'title' | 'body' | 'tags';

export interface PublishFieldError {
  field: PublishField;
  message: string;
}

export interface PublishCandidate {
  title: string;
  bodyText: string;
  tags: readonly string[];
}

/**
 * Every reason this article cannot be published, at once.
 *
 * All of them, not the first: SPEC-007's oracle asks for "a field-level error",
 * and a form that reveals its next problem only after you fix the current one
 * is a form the author submits four times. Same reasoning as
 * `validateSignUp` in `lib/auth/validation.ts`, and deliberately the same
 * shape, so the editor's error rendering looks like the sign-up form's.
 */
export function validatePublish(candidate: PublishCandidate): PublishFieldError[] {
  const errors: PublishFieldError[] = [];

  if (candidate.title.trim().length === 0) {
    errors.push({ field: 'title', message: 'Give the article a title before publishing.' });
  }

  // Measured on `bodyText` — the canonical plaintext projection from
  // `lib/derive/reading.ts` — and not on the raw JSON or the HTML. Counting
  // characters of `bodyJson` would let an article of markup and no words past
  // the guard; counting HTML would make the threshold depend on how many tags
  // the author happened to use.
  const length = candidate.bodyText.trim().length;
  if (length < MIN_BODY_TEXT_CHARS) {
    errors.push({
      field: 'body',
      message: `Write at least ${MIN_BODY_TEXT_CHARS} characters — this draft has ${length}.`,
    });
  }

  const tags = normalizeTagList(candidate.tags);
  if (tags.length < MIN_TAGS) {
    errors.push({ field: 'tags', message: 'Add at least one tag so readers can find this.' });
  } else if (tags.length > MAX_TAGS) {
    errors.push({
      field: 'tags',
      message: `Use at most ${MAX_TAGS} tags — this draft has ${tags.length}.`,
    });
  }

  return errors;
}

/**
 * Drop blanks and exact duplicates, preserving order.
 *
 * Counting is done on this list rather than on the raw input so that a trailing
 * empty chip left behind by the tag input does not read as a tag, and so
 * `['a', 'a']` is one tag — which is what `setArticleTags` will store, and the
 * guard must agree with the write or an article can pass validation and then
 * fail to persist what was validated.
 */
export function normalizeTagList(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** True when nothing blocks publication. */
export function canPublish(candidate: PublishCandidate): boolean {
  return validatePublish(candidate).length === 0;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface PublishOk {
  ok: true;
  status: 200;
  articleId: string;
  slug: string;
  articleStatus: ArticleStatus;
  publishedAt: string | null;
  version: number;
}

export interface PublishRejected {
  ok: false;
  status: 400 | 404;
  errors: PublishFieldError[];
}

export type PublishResult = PublishOk | PublishRejected;

function ok(article: ArticleRecord): PublishOk {
  return {
    ok: true,
    status: 200,
    articleId: article.id,
    slug: article.slug,
    articleStatus: article.status as ArticleStatus,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    version: article.version,
  };
}

function notFound(): PublishRejected {
  return {
    ok: false,
    status: 404,
    errors: [{ field: 'title', message: 'That draft no longer exists.' }],
  };
}

export interface PublishInput {
  /** The title being published. Defaults to the stored one. */
  title?: string;
  /** The tag set being published. Defaults to the tags already attached. */
  tags?: readonly string[];
}

/**
 * `DRAFT -> PUBLISHED`, and the edit-and-republish case.
 *
 * The ordering below is load-bearing in two places:
 *
 *  1. **Validate, then write.** Nothing is written until the guards pass, so a
 *     rejected publish leaves `status`, `version`, `updatedAt` and the tag set
 *     exactly as they were. A "publish then roll back" shape would satisfy the
 *     letter of "the row stays DRAFT" while bumping `version` — and a bumped
 *     version would make the author's next autosave collide with a save they
 *     never made.
 *  2. **Title before publish.** `updateArticle` recomputes the slug from the
 *     title only while `publishedAt` is null (SPEC-004: immutable after first
 *     publish). Applying the title first therefore gives the article the URL
 *     its final title implies; applying it after would freeze the slug against
 *     whatever the title was when the draft was created, and "Untitled" would
 *     be in the URL forever.
 *
 * `bodyText` is re-derived from the STORED `bodyJson` rather than taken from a
 * parameter. The 50-character guard is about what will actually be published,
 * and a caller that could hand in its own `bodyText` could hand in one that
 * does not match the document.
 */
export async function publishDraft(
  articleId: string,
  input: PublishInput = {},
  now: Date = new Date(),
): Promise<PublishResult> {
  const existing = await getArticleById(articleId);
  if (!existing) return notFound();

  const title = input.title ?? existing.title;
  const tags = normalizeTagList(
    input.tags ?? (await listTagsForArticle(articleId)).map((tag) => tag.name),
  );
  const { bodyText } = deriveContent(existing.bodyJson);

  const errors = validatePublish({ title, bodyText, tags });
  if (errors.length > 0) return { ok: false, status: 400, errors };

  if (title !== existing.title) {
    await updateArticle(articleId, { title, now });
  }

  try {
    await setArticleTags(articleId, tags);
  } catch (error) {
    if (!(error instanceof TooManyTagsError)) throw error;
    // Unreachable given the guard above, which counts the same normalised list
    // the repository deduplicates. Mapped rather than thrown because an
    // unhandled repository error in a Server Action is an opaque 500, and this
    // one has a perfectly good field to attach itself to.
    return {
      ok: false,
      status: 400,
      errors: [{ field: 'tags', message: `Use at most ${MAX_TAGS} tags.` }],
    };
  }

  return ok(await publishArticle(articleId, now));
}

/**
 * `PUBLISHED -> DRAFT`.
 *
 * `publishedAt` and `slug` are both retained, by `unpublishArticle` — see its
 * comment for why: clearing `publishedAt` would un-freeze the slug, and a
 * republish would then mint a new URL for an article people already hold links
 * to. Unpublishing is meant to be reversible without breaking the web.
 *
 * The article leaves the feed and the search index because both are defined
 * over `status = 'PUBLISHED'`; nothing here has to remove it from either.
 */
export async function unpublishDraft(
  articleId: string,
  now: Date = new Date(),
): Promise<PublishResult> {
  const existing = await getArticleById(articleId);
  if (!existing) return notFound();
  if (existing.status === ARTICLE_STATUS.DRAFT) return ok(existing);
  return ok(await unpublishArticle(articleId, now));
}

/**
 * Hard delete, cascading per SPEC-004.
 *
 * Returns the deleted article's identity rather than void, so the action can
 * report what it removed after the row is gone.
 */
export async function deleteDraft(articleId: string): Promise<PublishResult> {
  const existing = await getArticleById(articleId);
  if (!existing) return notFound();
  await deleteArticle(articleId);
  return ok(existing);
}
