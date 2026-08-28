/**
 * The SERVER half of content: every write to an article's body or state
 * (SPEC-007).
 *
 * ── Why the split runs here and not between "autosave" and "publish" ──────
 * This module imports `lib/db/**`, so it can never be reached from a client
 * component: `lib/db/articles.ts` pulls in `lib/db/ids.ts` -> `node:crypto`,
 * which the browser build cannot resolve, and a client bundle carrying the
 * repository layer would carry the SQL with it. `lib/content/autosave.ts` is
 * the client-safe half and holds the state machine, the indicator strings and
 * the pure guards; everything that WRITES is here — `saveDraftContent`,
 * `createDraftContent`, and the four transitions below.
 *
 * So the two modules are divided by which side of the wire they run on, not by
 * subject matter. The header on `autosave.ts` says the same thing from the
 * other side; between them they are the whole contract.
 *
 * ── The publish state machine (SPEC-007) ─────────────────────────────────
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
 * Being pure is also what lets it live on the client side of the split and be
 * called from BOTH: the form runs it for immediate feedback, this module runs
 * the same function before it writes. One rule, two callers — not two rules.
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
  EmptyTitleError,
  createArticle,
  deleteArticle,
  getArticleById,
  normalizeTitle,
  publishArticle,
  unpublishArticle,
  updateArticle,
} from '../db/articles';
import {
  MAX_TAGS_PER_ARTICLE,
  TooManyTagsError,
  listTagsForArticle,
  setArticleTags,
} from '../db/tags';
import { deriveContent } from './render';
import { toProseMirrorNode } from './schema';
import {
  type DraftInput,
  type PublishFieldError,
  type SaveDraftResult,
  CONFLICT_MESSAGE,
  MAX_TAGS,
  MIN_TAGS,
  MIN_BODY_TEXT_CHARS,
  normalizeTagList,
  validatePublish,
} from './autosave';

/**
 * The guards are re-exported, not redefined.
 *
 * They live in `lib/content/autosave.ts` because the editor form runs them for
 * immediate feedback and that module is client-safe. Re-exporting here means a
 * server-side caller reads one import and cannot accidentally reach a second,
 * divergent copy — there is exactly one `validatePublish` in the codebase, and
 * both sides call it.
 */
export {
  type PublishCandidate,
  type PublishField,
  type PublishFieldError,
  MAX_TAGS,
  MIN_TAGS,
  MIN_BODY_TEXT_CHARS,
  canPublish,
  normalizeTagList,
  validatePublish,
} from './autosave';

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

// ---------------------------------------------------------------------------
// Draft saves — the autosave write path
// ---------------------------------------------------------------------------

/**
 * Apply one autosave.
 *
 * Ordering is the whole contract, and it is: read, compare, reject-or-write.
 * Nothing before the version comparison writes anything, so a stale save leaves
 * the row byte-identical — including `updatedAt` and `version`, which a
 * "write then detect" implementation would have moved.
 *
 * Authorization is NOT checked here. It is checked by the Server Action through
 * `guardArticleMutation`, which makes the write unreachable unless the caller
 * owns the article. Doing it in both places would mean two rules to keep in
 * step; doing it in the combinator means the check cannot be skipped.
 */
export async function saveDraftContent(
  articleId: string,
  input: DraftInput,
  now: Date = new Date(),
): Promise<SaveDraftResult> {
  const existing = await getArticleById(articleId);
  if (!existing) {
    return { ok: false, status: 404, message: 'That draft no longer exists.' };
  }

  if (!Number.isInteger(input.version) || input.version !== existing.version) {
    return {
      ok: false,
      status: 409,
      serverVersion: existing.version,
      message: CONFLICT_MESSAGE,
    };
  }

  // Validated before the write for the same reason as the version check: a
  // draft whose title was cleared must not be half-saved. `normalizeTitle`
  // throws on empty, and an untitled draft is a legitimate state to be IN — it
  // is only publishing that requires a title — so an empty title keeps the
  // stored one rather than failing the save. An author who selects-all-deletes
  // their title mid-edit should not see "Save failed".
  let title: string;
  try {
    title = normalizeTitle(input.title);
  } catch (error) {
    if (!(error instanceof EmptyTitleError)) throw error;
    title = existing.title;
  }

  if (input.tags && input.tags.length > MAX_TAGS_PER_ARTICLE) {
    return {
      ok: false,
      status: 400,
      field: 'tags',
      message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
    };
  }

  // The sanitised document is what gets stored — never `input.bodyJson`. That
  // is the line that makes the security boundary server-side: a client posting
  // a hand-written document with a `<script>` node has it removed here, not in
  // the component that happened to render it.
  const derived = deriveContent(input.bodyJson);

  const updated: ArticleRecord = await updateArticle(articleId, {
    title,
    subtitle: input.subtitle ?? null,
    coverPath: input.coverPath ?? null,
    bodyJson: toProseMirrorNode(derived.doc),
    bodyHtml: derived.bodyHtml,
    now,
  });

  if (input.tags) {
    try {
      await setArticleTags(articleId, input.tags);
    } catch (error) {
      // The ceiling is re-checked by the repository against the DEDUPLICATED
      // set, so a list of six that collapses to five is legal and only this
      // path knows it was not. The content is already saved; reporting the tag
      // problem without losing the prose is the right trade.
      if (!(error instanceof TooManyTagsError)) throw error;
      return {
        ok: false,
        status: 400,
        field: 'tags',
        message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
      };
    }
  }

  return {
    ok: true,
    status: 200,
    savedAt: updated.updatedAt.toISOString(),
    version: updated.version,
    slug: updated.slug,
    readingMinutes: updated.readingMinutes,
  };
}

/** The title a draft carries until its author gives it one. */
export const UNTITLED_DRAFT = 'Untitled';

/**
 * The first save of a document written at `/editor/new`.
 *
 * `/editor/new` deliberately does NOT create a row when it renders. A page that
 * mints an article on GET leaves a trail of empty drafts behind every visit,
 * every refresh and every back-button — and `/editor` is behind the session
 * check, so those rows all belong to a real author and all show up in their
 * profile's draft count. The row appears on the first autosave instead, which
 * is the first moment there is anything to store.
 *
 * `createArticle` refuses an empty title (SPEC-004: "title, 1-120 chars"), so
 * an untouched title field becomes `Untitled` here. That is a real,
 * publishable-looking name in the slug — but only until the author types one,
 * because `updateArticle` recomputes the slug from the title on every save
 * while `publishedAt` is null. The placeholder therefore cannot survive into a
 * published URL unless the author genuinely publishes something untitled, which
 * `validatePublish` refuses.
 */
export async function createDraftContent(
  authorId: string,
  input: Omit<DraftInput, 'version'>,
  now: Date = new Date(),
): Promise<SaveDraftResult> {
  if (input.tags && input.tags.length > MAX_TAGS_PER_ARTICLE) {
    return {
      ok: false,
      status: 400,
      field: 'tags',
      message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
    };
  }

  const derived = deriveContent(input.bodyJson);
  const title = input.title.trim().length > 0 ? input.title : UNTITLED_DRAFT;

  const created = await createArticle({
    authorId,
    title,
    subtitle: input.subtitle ?? null,
    bodyJson: toProseMirrorNode(derived.doc),
    bodyHtml: derived.bodyHtml,
    coverPath: input.coverPath ?? null,
    now,
  });

  if (input.tags && input.tags.length > 0) {
    try {
      await setArticleTags(created.id, input.tags);
    } catch (error) {
      if (!(error instanceof TooManyTagsError)) throw error;
      return {
        ok: false,
        status: 400,
        field: 'tags',
        message: `An article can carry at most ${MAX_TAGS_PER_ARTICLE} tags.`,
      };
    }
  }

  return {
    ok: true,
    status: 200,
    savedAt: created.updatedAt.toISOString(),
    version: created.version,
    slug: created.slug,
    readingMinutes: created.readingMinutes,
    articleId: created.id,
  };
}
