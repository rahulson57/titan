'use server';

/**
 * The three engagement Server Actions (SPEC-009).
 *
 * Every one of them is four lines: resolve the session, delegate to
 * `lib/engage/`, hand the result back. That is the whole file on purpose.
 *
 * ── Why the rules are not in here ─────────────────────────────────────────
 * A `'use server'` module cannot be imported into a Vitest process: it reaches
 * `cookies()` via `lib/auth/session.ts`, and `next/headers` throws the instant
 * it is evaluated outside a request scope. Anything decided in this file is
 * therefore only reachable through a browser — and three of SPEC-009's
 * criteria ("leaves exactly one Clap row with `count = 50`", "leaves zero
 * rows", "`followerCount` matches `COUNT(*)` exactly") are assertions about
 * DATABASE ROWS that a browser cannot see. So the rules live in `lib/engage/`
 * where a unit test can call them sixty times and read the rows back, and this
 * module is the request-bound shell around them.
 *
 * It is the same shape `lib/auth/session.ts` uses for its own request-bound
 * half, and the same reason: *"the pure rules above are the part most worth
 * testing."*
 *
 * ── Why every action re-resolves the session ──────────────────────────────
 * A Server Action is a real, addressable POST endpoint — Next mints an id for
 * it and anything that can reach the origin can invoke it. The fact that the
 * only button is on a page that checked the session means nothing to a
 * hand-written request. So authorization is re-established here, per call, and
 * the actor is taken from the cookie rather than from an argument: there is no
 * parameter a caller could supply to clap, save, or follow *as somebody else*.
 * `removeBookmarkAction` in `app/bookmarks/actions.ts` makes the same argument
 * at greater length.
 *
 * SPEC-005's CSRF answer covers the rest: Server Actions carry Next's built-in
 * origin check and the session cookie is `sameSite=lax`, so a cross-site POST
 * arrives without a session and resolves to anonymous — which these actions
 * answer with 401.
 *
 * ── Why nothing here calls `revalidatePath` ───────────────────────────────
 * `/bookmarks` revalidates because its mutation REMOVES A ROW FROM A LIST and
 * the server has to re-render the list. These three mutations change a number
 * and a filled state that the client is already tracking optimistically, and
 * the authoritative value is in the return. Revalidating as well would
 * re-render the whole article — body, cover and all — to update a counter the
 * response already carried, and would race the optimistic state it is meant to
 * confirm.
 *
 * ── Why they return values instead of throwing ────────────────────────────
 * An exception thrown out of a Server Action reaches the client redacted to
 * "An error occurred in the Server Components render". The optimistic controls
 * have to distinguish "you are signed out" (401 → send them to `/signin`) from
 * "this failed, put the number back" — so the status crosses the wire as data.
 */

import { auth } from '../../../lib/auth/session';
import { applyBookmark, type BookmarkOutcome } from '../../../lib/engage/bookmark';
import { applyClap, type ClapOutcome } from '../../../lib/engage/clap';
import { applyFollow, type FollowOutcome } from '../../../lib/engage/follow';

/**
 * Add `by` claps as the signed-in reader (SPEC-009).
 *
 * `by` is the size of the client's coalesced burst, not a count the caller may
 * choose freely: `applyClap` trims it to the reader's remaining headroom, so a
 * forged request asking for a thousand still lands on 50, and one asking for
 * zero or a negative writes nothing at all (DEC-019).
 */
export async function clapAction(articleId: string, by = 1): Promise<ClapOutcome> {
  return applyClap((await auth())?.user ?? null, articleId, by);
}

/** Toggle the signed-in reader's bookmark on this article (SPEC-009). */
export async function bookmarkAction(articleId: string): Promise<BookmarkOutcome> {
  return applyBookmark((await auth())?.user ?? null, articleId);
}

/** Toggle the signed-in reader's follow of this author (SPEC-009). */
export async function followAction(targetUserId: string): Promise<FollowOutcome> {
  return applyFollow((await auth())?.user ?? null, targetUserId);
}
