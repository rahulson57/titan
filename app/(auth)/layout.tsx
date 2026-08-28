/**
 * The `(auth)` route group's guard — SPEC-011, DEC-030.
 *
 * > "`/signin`, `/signup` — anonymous — signed-in visitor → redirect `/`."
 *
 * ── Why the guard is HERE and not on the two pages ────────────────────────
 * Because one of them cannot host it. `app/(auth)/signup/page.tsx` is a Client
 * Component — it has to be, since SPEC-005's oracle asserts per-field errors
 * (`data-field-error`, `aria-invalid`) that are carried across a rejection by
 * `useActionState` — and a Client Component can neither call `auth()` nor
 * issue a server redirect. `'use client'` is module-scoped, so there is no
 * arrangement in which that file holds both the form and a server guard.
 *
 * `/signin` could have guarded itself, and deliberately does not. Two guards
 * for one rule is a drift hazard: a later edit fixes one and leaves the other,
 * and a test that only checks the composite behaviour never notices the stale
 * one. One guard, one place — and it covers both routes, which is exactly how
 * the criterion is phrased.
 *
 * ── Why NOT in middleware, which would be the smaller diff ────────────────
 * DEC-025 forbids it, and the reason is worth keeping next to the code rather
 * than in a decision log. `middleware.ts` runs on the Edge runtime, which has
 * no database, so it can only see that a `titan.session` cookie is *present* —
 * not that it names a live session.
 *
 * A visitor whose session merely EXPIRED still carries that cookie. A
 * middleware redirect would bounce them off `/signin` — the one page they need
 * in order to sign in again — every time, with no way out. `auth()` resolves
 * the cookie against the `Session` table, so a stale id is simply anonymous
 * and the form renders. `tests/e2e/auth.spec.ts` asserts precisely that by
 * replaying a deleted session's cookie.
 *
 * ── What this does NOT do ─────────────────────────────────────────────────
 * It does not render chrome. This layout nests inside the root layout, so
 * `TopNav` is already above it — which means an anonymous visitor standing on
 * `/signin` sees `Sign in` and `Get started` in the nav. That is correct
 * (SPEC-011: chrome around every page) and is not a bug to fix.
 */

import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { auth } from '../../lib/auth/session';
import { HOME } from '../../lib/routes';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  // A LIVE session, not merely a cookie. See the header for why that
  // distinction is the whole reason this guard is on the server and not in
  // middleware.
  if (session) redirect(HOME);

  return <>{children}</>;
}
