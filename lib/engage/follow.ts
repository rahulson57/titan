/**
 * The follow mutation (SPEC-009).
 *
 * > | `follow` | `(userId) => { following, followerCount }` | Idempotent
 * > toggle. Self-follow → `SelfFollowError` 400. Anonymous → 401. |
 *
 * Same viewer-as-parameter split as its two siblings; see `lib/engage/clap.ts`
 * for why the rule lives outside the Server Action.
 *
 * ── Why this one does NOT return `GuardResult` ────────────────────────────
 * `GuardResult` (SPEC-005) admits 401, 403 and 404 — the three answers an
 * *authorization* check can give. Self-follow is none of those. The caller is
 * authenticated, is permitted to follow people, and the target exists; the
 * request is simply not a coherent thing to ask for, which is what 400 means
 * and is what SPEC-009 specifies. Widening `GuardResult` to carry 400 would
 * push a non-authorization status into a type every other slice's guard
 * returns, so the union is stated here instead.
 *
 * `code` is on the failure shape for the same reason the status is: the
 * criterion is *"`follow` on self returns a 400 `SelfFollowError`"*, and a
 * client that has to string-match an English message to tell one 400 from
 * another will break the first time the message is reworded.
 */

import type { SessionUser } from '../auth/session';
import { SelfFollowError, getFollowerCount, isFollowing, toggleFollow } from '../db/social';
import { findUserById } from '../db/users';

export { SelfFollowError };

/** What the control renders. `followerCount` is `COUNT(*)`, never stored. */
export interface FollowState {
  following: boolean;
  followerCount: number;
}

/** The one failure code this action can produce that is not an authorization answer. */
export const SELF_FOLLOW_CODE = 'SelfFollowError';

export type FollowOutcome =
  | { ok: true; status: 200; value: FollowState }
  | { ok: false; status: 400 | 401 | 404; error: string; code?: typeof SELF_FOLLOW_CODE };

/**
 * The author's follower count, and whether this viewer is one of them.
 *
 * Anonymous gets `following: false` with the real count — the count is public
 * information on a public profile row, and the author card renders it whether
 * or not anyone is signed in.
 */
export async function readFollowState(
  viewer: SessionUser | null,
  targetUserId: string,
): Promise<FollowState> {
  const [followerCount, following] = await Promise.all([
    getFollowerCount(targetUserId),
    viewer ? isFollowing(viewer.id, targetUserId) : Promise.resolve(false),
  ]);
  return { following, followerCount };
}

/**
 * Follow or unfollow `targetUserId` on the caller's behalf.
 *
 * ── Order of the checks is load-bearing ───────────────────────────────────
 * Anonymous is answered before self-follow. A null viewer cannot equal the
 * target, so the two can never both fire — but stating the order makes the
 * 401 unconditional, which is what *"invoked anonymously returns HTTP 401 and
 * writes zero rows"* asks for. Existence is checked last, and only for a
 * caller who has already passed both, so an anonymous request cannot use the
 * 404 to learn which user ids are real.
 *
 * ── Why the self-follow throw is NOT caught ───────────────────────────────
 * `toggleFollow` raises `SelfFollowError` before it writes anything, so the
 * repository is a genuine backstop. It is deliberately left to propagate.
 * Catching it here and answering 400 would be answering for a state that
 * cannot arise: the check below has already compared the same two ids, so the
 * repository's throw is reachable only if the two guards disagree — which is a
 * defect in this file, not a malformed request. A 400 would present that
 * defect to the reader as their mistake and hide it from us; an unhandled
 * throw is a 500 that says something is wrong, which is the truth. The
 * alternative — a `catch` that can never run — is a branch no test can reach
 * and therefore a claim nothing verifies.
 */
export async function applyFollow(
  viewer: SessionUser | null,
  targetUserId: string,
  now: Date = new Date(),
): Promise<FollowOutcome> {
  if (!viewer) {
    return { ok: false, status: 401, error: 'You must be signed in to do that.' };
  }

  if (viewer.id === targetUserId) {
    return {
      ok: false,
      status: 400,
      error: new SelfFollowError(viewer.id).message,
      code: SELF_FOLLOW_CODE,
    };
  }

  const target = await findUserById(targetUserId);
  if (!target) return { ok: false, status: 404, error: 'Not found.' };

  return { ok: true, status: 200, value: await toggleFollow(viewer.id, targetUserId, now) };
}
