/**
 * The bookmark mutation (SPEC-009).
 *
 * > | `bookmark` | `(articleId) => { bookmarked }` | Idempotent toggle.
 * > Anonymous → 401. |
 *
 * Same split as `lib/engage/clap.ts`, for the same reason: the viewer is a
 * parameter, so the rule is reachable from Vitest and the Server Action in
 * `app/article/[slug]/actions.ts` is left with nothing but session resolution.
 * See that module's header for the argument in full.
 *
 * ── "Idempotent toggle" is a claim about the RESULT, not the request ──────
 * `toggleBookmark` returns the state it left behind rather than the one it
 * found (`lib/db/social.ts`), and that is what makes the optimistic UI
 * correctable: a control that flipped to "saved" on click can be set to
 * exactly what the server holds when the answer arrives, with no inference
 * about which way the toggle went. Two calls therefore return `true` then
 * `false` and leave zero rows — the criterion this slice is measured on.
 *
 * ── Why there is no "already bookmarked" error ────────────────────────────
 * A double click on a slow connection is the common case, not the exotic one.
 * The coalescing that protects the clap control is not applied here because a
 * toggle has no accumulation to coalesce: the second tap of a double-tap
 * genuinely means "undo the first". Both calls are honoured and the returned
 * value tells the client where it ended up.
 */

import { canViewArticle, type GuardResult, type SessionUser } from '../auth/session';
import { getArticleById } from '../db/articles';
import { isBookmarked, toggleBookmark } from '../db/social';

/** What the control renders. */
export interface BookmarkState {
  bookmarked: boolean;
}

export type BookmarkOutcome = GuardResult<BookmarkState>;

/**
 * Whether this viewer has saved this article.
 *
 * Anonymous is `false`, not an error: the control renders in a signed-out
 * state that routes to `/signin`, and it has to render something.
 */
export async function readBookmarkState(
  viewer: SessionUser | null,
  articleId: string,
): Promise<BookmarkState> {
  if (!viewer) return { bookmarked: false };
  return { bookmarked: await isBookmarked(viewer.id, articleId) };
}

/**
 * Flip the caller's bookmark on this article.
 *
 * The owner is taken from `viewer` and never from a parameter, so there is no
 * argument an attacker could supply that would move somebody else's row — the
 * same structural authorization `removeBookmarkAction` relies on.
 */
export async function applyBookmark(
  viewer: SessionUser | null,
  articleId: string,
  now: Date = new Date(),
): Promise<BookmarkOutcome> {
  if (!viewer) {
    return { ok: false, status: 401, error: 'You must be signed in to do that.' };
  }

  const article = await getArticleById(articleId);
  // Absent and not-visible are the same answer, so a bookmark attempt cannot
  // be used to discover that somebody's draft exists (SPEC-005).
  if (!article || !canViewArticle(viewer, article)) {
    return { ok: false, status: 404, error: 'Not found.' };
  }

  return { ok: true, status: 200, value: await toggleBookmark(viewer.id, articleId, now) };
}
