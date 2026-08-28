/**
 * The clap mutation, as a rule rather than as a Server Action (SPEC-009).
 *
 * > | `clap` | `(articleId) => { total, mine }` | Anonymous → 401. Each
 * > invocation increments the caller's `Clap.count` by 1, **capped at 50** per
 * > (user, article). Beyond 50 it is a no-op returning the existing total, not
 * > an error. |
 *
 * ── Why this is not the Server Action itself ──────────────────────────────
 * `app/article/[slug]/actions.ts` is the Server Action: it resolves the
 * session from `cookies()` and delegates here. Everything that decides an
 * OUTCOME lives in this module, and it takes the viewer as an argument.
 *
 * That split is what makes SPEC-009's oracle checkable at all. The criteria
 * ask things like "calling `clap` 60 times as one user leaves exactly one Clap
 * row with `count = 50`" and "invoked anonymously returns HTTP 401 and writes
 * zero rows" — sixty invocations and an anonymous invocation. A `'use server'`
 * module cannot be called sixty times from Vitest: `next/headers` throws the
 * moment it is evaluated outside a request scope, so the assertions would have
 * to be made through a browser, where "wrote zero rows" is not observable.
 * With the viewer as a parameter, `tests/unit/engage-clap.test.ts` runs the
 * real function against a real SQLite file and reads the rows back.
 *
 * It is also why the coverage budget (SPEC-002: statements >= 80% on `lib/**`)
 * is satisfiable for this slice at all — a rule that only exists inside an
 * action is a rule no unit test can reach.
 *
 * ── The status, and why it is returned rather than thrown ─────────────────
 * `GuardResult<T>` is SPEC-005's shape (`lib/auth/session.ts`), reused rather
 * than reinvented: *"the shape SPEC-007/009/010's actions are meant to
 * consume."* A thrown error crossing a Server Action boundary reaches the
 * client as a redacted "An error occurred in the Server Components render",
 * which is exactly the wrong thing for an optimistic UI that has to decide
 * whether to roll back. A value carries the status intact.
 */

import { canViewArticle, type GuardResult, type SessionUser } from '../auth/session';
import { getArticleById } from '../db/articles';
import {
  MAX_CLAPS_PER_READER,
  getClapByReader,
  getClapTotal,
  incrementClap,
} from '../db/social';

export { MAX_CLAPS_PER_READER };

/**
 * SPEC-009: *"Clap taps are coalesced client-side into one action call per
 * 400 ms burst."*
 *
 * The window lives here, next to the rule it protects, rather than as a
 * literal in `ClapButton.tsx`. `tests/e2e/engage-coalesce.spec.ts` asserts the
 * behaviour against this constant, so the test cannot silently agree with a
 * component that changed its mind.
 */
export const CLAP_BURST_MS = 400;

/** What the control renders: the article's total, and this reader's share. */
export interface ClapState {
  /** `SUM(count)` across every reader — a read-time aggregate (SPEC-004). */
  total: number;
  /** This reader's own contribution, 0..50. Drives the control's filled state. */
  mine: number;
}

export type ClapOutcome = GuardResult<ClapState>;

/**
 * The article's clap state as this viewer sees it.
 *
 * Anonymous readers get `mine: 0` rather than an error — SPEC-009 requires
 * that *"anonymous readers can read, search, and browse everything
 * published"*, and the count is part of reading.
 */
export async function readClapState(
  viewer: SessionUser | null,
  articleId: string,
): Promise<ClapState> {
  const [total, mine] = await Promise.all([
    getClapTotal(articleId),
    viewer ? getClapByReader(viewer.id, articleId) : Promise.resolve(0),
  ]);
  return { total, mine };
}

/**
 * Add `by` claps on the caller's behalf, saturating at 50.
 *
 * ── DEC-019: a non-positive `by` is a NO-OP ───────────────────────────────
 * The decision hands TASK-009 the ruling on `incrementClap(by <= 0)`, which
 * floors up to 1 and CREATES a clap row for a call that meant "add nothing".
 * The ruling is that **it is a no-op**: no row is created, no count moves, and
 * the caller gets the state the server already held.
 *
 * It is enforced HERE rather than in `lib/db/social.ts` because the hazard
 * DEC-019 names — *"retry logic, optimistic-UI rollback, or a coalescing path
 * that computes a delta of zero"* — is entirely this module's callers. The
 * coalescing window above is precisely such a path: a burst that flushes with
 * nothing accumulated computes a delta of zero, and under the repository's
 * floor-up that would mint a clap the reader never made. Guarding the one door
 * that opens onto the hazard closes it completely, and leaves SPEC-004's
 * repository contract and its passing test untouched — neither of which is in
 * this task's file scope to change. (Raised with the coordinator as MSG-2416
 * rather than done quietly.)
 *
 * ── The ceiling is also a no-op, not a clamped write ──────────────────────
 * At 50 this returns without touching the database. `incrementClap` would
 * saturate correctly on its own, so this is not needed for the *count* to be
 * right — it is needed for *"beyond 50 it is a no-op"* to be literally true.
 * A saturating write still rewrites the row, which moves nothing a reader can
 * see but does turn every one of the 51st..60th taps into a write against a
 * value that cannot change. `by` is likewise trimmed to the remaining headroom
 * so a coalesced burst of ten taps against a reader on 45 writes 50 rather
 * than asking the repository to discard the overshoot.
 */
export async function applyClap(
  viewer: SessionUser | null,
  articleId: string,
  by = 1,
  now: Date = new Date(),
): Promise<ClapOutcome> {
  if (!viewer) {
    return { ok: false, status: 401, error: 'You must be signed in to do that.' };
  }

  const article = await getArticleById(articleId);
  // A draft belongs to its author alone (SPEC-005), and an article that does
  // not exist is indistinguishable from one you may not see — both are 404, so
  // engagement cannot be used to probe for unpublished work.
  if (!article || !canViewArticle(viewer, article)) {
    return { ok: false, status: 404, error: 'Not found.' };
  }

  const current = await readClapState(viewer, articleId);

  const room = MAX_CLAPS_PER_READER - current.mine;
  const delta = Math.min(Math.trunc(by), room);
  if (delta <= 0) return { ok: true, status: 200, value: current };

  await incrementClap(viewer.id, articleId, delta, now);

  // Re-read rather than compute `total + delta`. Another reader's clap between
  // the two statements would make an arithmetic answer wrong, and the whole
  // point of returning a value here is that the client can trust it enough to
  // roll its optimistic guess back onto it.
  return { ok: true, status: 200, value: await readClapState(viewer, articleId) };
}
