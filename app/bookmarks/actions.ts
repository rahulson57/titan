'use server';

/**
 * `/bookmarks` mutations (SPEC-011).
 *
 * The page owns one mutation — the inline un-bookmark control — and SPEC-011
 * fixes its behaviour: *"`ArticleCard` rows with an inline un-bookmark control
 * that removes the row from the list without a full reload."*
 *
 * ── Why a Server Action and not a client fetch ────────────────────────────
 * "Without a full reload" is a property of Server Actions, not something that
 * has to be engineered around them. A `<form action={removeBookmarkAction}>`
 * posts, runs this function on the server, and — because of the
 * `revalidatePath` below — Next streams back a re-rendered tree and patches
 * the existing document. The browser never navigates, the scroll position is
 * kept, and the row disappears. No client component, no `useState`, no
 * `fetch`, and no `/api` route that would need its own authorization.
 *
 * It also degrades correctly: with JavaScript disabled the same form performs
 * an ordinary POST and the page re-renders. The reader loses the seamlessness
 * and keeps the function, which is the right way round.
 *
 * ── Why the authorization check is HERE and not only on the page ──────────
 * A Server Action is a real, addressable POST endpoint. Next generates an id
 * for it and anything that can reach the origin can invoke it — the fact that
 * the only *button* is on a page behind a session check means nothing to a
 * hand-written request. So this function resolves the session itself and acts
 * only on the caller's own row.
 *
 * That is also why the action takes an `articleId` and never a `userId`: the
 * owner is taken from the session, so there is no parameter an attacker could
 * supply to delete somebody else's bookmark. The authorization is structural
 * rather than a check that could be forgotten — the same reasoning
 * `guardArticleMutation` in `lib/auth/session.ts` applies to article writes.
 *
 * SPEC-005's CSRF answer covers the rest: Server Actions carry Next's built-in
 * origin check and the session cookie is `sameSite=lax`, so a cross-site POST
 * arrives without a session and resolves to anonymous.
 *
 * ── Note on the module boundary ───────────────────────────────────────────
 * Next permits a `'use server'` module to export ONLY async functions, so
 * everything else in here stays module-private. The deletion itself goes
 * through `removeBookmark` in `lib/db/social.ts` — SPEC-004's repository layer
 * — rather than touching the client directly.
 */

import { revalidatePath } from 'next/cache';

import { auth } from '../../lib/auth/session';
import { removeBookmark } from '../../lib/db/social';
import { BOOKMARKS } from '../../lib/routes';

/**
 * Remove one of the caller's own bookmarks.
 *
 * Returns silently when there is no session or no `articleId`. That is
 * deliberate: this is a form action, and the only ways to reach either branch
 * are a session that expired while the page sat open, or a forged request.
 * The first deserves a re-render (which the caller gets — the page's own
 * session check will then redirect to `/signin`), and the second deserves no
 * information at all. Throwing would surface the global error boundary to a
 * reader whose only mistake was leaving a tab open overnight.
 *
 * `removeBookmark` is a `deleteMany`, so removing a bookmark that is already
 * gone is a no-op rather than an error — which matters because the double
 * click on a slow connection is the common case, not the exotic one.
 */
export async function removeBookmarkAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session) return;

  const articleId = formData.get('articleId');
  if (typeof articleId !== 'string' || articleId.length === 0) return;

  await removeBookmark(session.user.id, articleId);

  // This is what makes the row vanish without a navigation: it invalidates the
  // cached render of `/bookmarks` so the response to this POST carries the
  // fresh list, which React reconciles into the live document.
  revalidatePath(BOOKMARKS);
}
