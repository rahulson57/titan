'use server';

/**
 * The editor's Server Actions (SPEC-007).
 *
 * | Action        | Guard                                    | Result                                |
 * |---------------|------------------------------------------|---------------------------------------|
 * | `saveDraft`   | author, and `version` matches the row     | `{ savedAt, version }` or `409`       |
 * | `publish`     | author, and `validatePublish` passes      | `{ slug, publishedAt }` or field errors|
 * | `unpublish`   | author                                    | back to `DRAFT`, slug retained         |
 * | `removeDraft` | author                                    | hard delete                            |
 *
 * ── This file is a wrapper, deliberately ──────────────────────────────────
 * Every function here does three things and nothing else: resolve the session,
 * hand the work to `guardArticleMutation`, and convert the result into a
 * plain object the client component can render. All the behaviour being tested
 * — the version comparison, the publish guards, the sanitisation — lives in
 * `lib/content/`, where Vitest can reach it without a request scope.
 *
 * That is not an aesthetic preference. SPEC-007's conflict and publish criteria
 * are asserted by UNIT tests (`tests/unit/editor-conflict.test.ts`,
 * `tests/unit/publish-guards.test.ts`), and a rule implemented inside a
 * `'use server'` module can only be exercised through a browser — which is the
 * one place an authorization or concurrency bug is least likely to be noticed,
 * because the assertion usually amounts to "the page looked right".
 *
 * ── Two constraints this file must keep ───────────────────────────────────
 *  1. **Only async functions may be exported.** Next treats a plain
 *     `export const` in a `'use server'` module as a build error that fails the
 *     whole route, not a lint warning. Every type and constant therefore lives
 *     in `lib/content/` and is re-imported here. `app/(auth)/actions.ts` says
 *     the same thing at the top for the same reason.
 *  2. **`guardArticleMutation` takes the mutation as a callback.** A guard that
 *     merely returns a boolean can be checked and then ignored, and that bug is
 *     invisible in review because the check sits three lines above the write.
 *     Here the write is unreachable unless the check passed.
 */

import { revalidatePath } from 'next/cache';

import { getArticleById } from '../../lib/db/articles';
import { auth } from '../../lib/auth/session';
import type { DraftInput, SaveDraftResult } from '../../lib/content/autosave';
import {
  type PublishInput,
  type PublishResult,
  createDraftContent,
  deleteDraft,
  publishDraft,
  saveDraftContent,
  unpublishDraft,
} from '../../lib/content/publish';
import { guardArticleMutation } from '../../lib/auth/session';

/**
 * Turn a failed guard into the shape the caller already handles.
 *
 * `401` and `403` are reported to the editor as a save failure rather than
 * thrown. An expired session mid-draft is the common case, and an exception
 * crossing the action boundary reaches the client as an opaque "an error
 * occurred" with the author's unsaved work still in the browser and no way to
 * tell whether it was stored. `Save failed — retry` at least says what to do.
 */
function fromGuard(status: 401 | 403 | 404, error: string): SaveDraftResult {
  return { ok: false, status: status === 404 ? 404 : 400, message: error };
}

function publishFromGuard(status: 401 | 403 | 404, error: string): PublishResult {
  return {
    ok: false,
    status: status === 404 ? 404 : 400,
    errors: [{ field: 'title', message: error }],
  };
}

/**
 * Create the row for a document written at `/editor/new`.
 *
 * Not guarded by `guardArticleMutation` — there is no article to own yet. The
 * check that matters is that there is a session at all, and the new row's
 * `authorId` is taken from it rather than from the request, so a caller cannot
 * create a draft under somebody else's name.
 */
export async function createDraft(input: Omit<DraftInput, 'version'>): Promise<SaveDraftResult> {
  const session = await auth();
  if (!session) return { ok: false, status: 400, message: 'You must be signed in to write.' };

  const result = await createDraftContent(session.user.id, input);
  if (result.ok) revalidatePath('/editor', 'layout');
  return result;
}

/**
 * One autosave.
 *
 * The `version` inside `input` is the client's last-known value; a mismatch
 * comes back as `{ ok: false, status: 409, serverVersion }` and the row is not
 * touched. See `saveDraftContent` for why the comparison happens before the
 * write rather than around it.
 */
export async function saveDraft(articleId: string, input: DraftInput): Promise<SaveDraftResult> {
  const session = await auth();

  const guarded = await guardArticleMutation(
    session?.user ?? null,
    articleId,
    getArticleById,
    () => saveDraftContent(articleId, input),
  );

  if (!guarded.ok) return fromGuard(guarded.status, guarded.error);
  return guarded.value;
}

/** `DRAFT -> PUBLISHED`, or a republish. Rejected publishes leave the row alone. */
export async function publish(articleId: string, input: PublishInput): Promise<PublishResult> {
  const session = await auth();

  const guarded = await guardArticleMutation(
    session?.user ?? null,
    articleId,
    getArticleById,
    () => publishDraft(articleId, input),
  );

  if (!guarded.ok) return publishFromGuard(guarded.status, guarded.error);

  if (guarded.value.ok) {
    // The article has just entered or re-entered the feed and the tag pages.
    // Revalidating from the root is broad on purpose: SPEC-008 owns those
    // routes and has not landed, so naming them here would encode a route map
    // this task does not own and would silently rot if it changed.
    revalidatePath('/', 'layout');
  }
  return guarded.value;
}

/** `PUBLISHED -> DRAFT`. The row survives; `slug` and `publishedAt` are retained. */
export async function unpublish(articleId: string): Promise<PublishResult> {
  const session = await auth();

  const guarded = await guardArticleMutation(
    session?.user ?? null,
    articleId,
    getArticleById,
    () => unpublishDraft(articleId),
  );

  if (!guarded.ok) return publishFromGuard(guarded.status, guarded.error);
  if (guarded.value.ok) revalidatePath('/', 'layout');
  return guarded.value;
}

/** Hard delete, cascading per SPEC-004. Author only. */
export async function removeDraft(articleId: string): Promise<PublishResult> {
  const session = await auth();

  const guarded = await guardArticleMutation(
    session?.user ?? null,
    articleId,
    getArticleById,
    () => deleteDraft(articleId),
  );

  if (!guarded.ok) return publishFromGuard(guarded.status, guarded.error);
  if (guarded.value.ok) revalidatePath('/', 'layout');
  return guarded.value;
}
