/**
 * Route-level session routing (SPEC-005).
 *
 * ── What this is, and — more importantly — what it is NOT ──────────────────
 * This middleware is a REDIRECTOR, not an authorization boundary. It reads
 * whether a `titan.session` cookie is PRESENT and routes accordingly. It does
 * not, and cannot, check whether that cookie names a live session.
 *
 * The reason is structural: Next middleware runs on the Edge runtime, which
 * has no Node APIs and therefore no Prisma and no SQLite. Validating a session
 * here would mean a database read that this runtime cannot perform. Next 15
 * offers an experimental Node runtime for middleware; adopting it would make
 * the app's boot depend on an unstable flag, which SPEC-001's one-command
 * boot contract has no appetite for.
 *
 * So the authoritative check lives where the data is — `auth()` in
 * `lib/auth/session.ts`, called by the page or action that actually needs a
 * user, and resolved against the `Session` table. That is the check that
 * enforces SPEC-005's authorization rules. This file only saves a signed-out
 * visitor a wasted page render, and sends them somewhere useful.
 *
 * The failure mode this ordering AVOIDS is the dangerous one. A forged or
 * expired `titan.session` cookie gets past this middleware — and then hits
 * `auth()`, which returns null, and the page renders signed-out or throws 401.
 * The cookie's presence buys a router decision and nothing else. If this file
 * were the only check, a hand-written cookie would be a login.
 *
 * ── Draft privacy is deliberately not here ────────────────────────────────
 * SPEC-005 requires a DRAFT article to 404 for anyone but its author. That
 * needs the article row — author and status — so it belongs to the route that
 * loads it (`requireVisibleArticle` in `lib/auth/session.ts`), not to a layer
 * that cannot read the database. Putting a half-check here would create two
 * places to get draft privacy right, and the weaker one would be the one
 * people trusted.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { NEXT_PARAM, SESSION_COOKIE, isProtectedPath } from './lib/auth/config';

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // Signed out, asking for something that needs a user: send them to sign in
  // and remember where they were going. `safeNextPath` re-validates this value
  // on the way back out, so a crafted `?next=` cannot survive the round trip.
  if (!hasSessionCookie && isProtectedPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/signin';
    url.search = '';
    url.searchParams.set(NEXT_PARAM, `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  // Deliberately NOT here: bouncing an already-signed-in visitor away from
  // `/signin`. That check belongs on the page, which — unlike this layer — can
  // read the database and therefore knows whether the cookie names a LIVE
  // session. Doing it here would bounce a user whose session had merely
  // expired away from the very page they need, on the strength of a cookie
  // that is no longer worth anything. `/signin` handles the signed-in case by
  // saying so and offering the way out (SPEC-005's `signOut`), which is a
  // better answer than a silent redirect in any case.

  return NextResponse.next();
}

/**
 * Which requests reach this middleware.
 *
 * Static assets, Next's own internals and `/uploads` (SPEC-006's local media)
 * are excluded — running a redirect check on every image and chunk costs
 * latency on the LCP budget SPEC-002 sets, and none of them is a protected
 * route. The matcher is a negative lookahead rather than a list of protected
 * prefixes so that adding one to `PROTECTED_PREFIXES` needs no second edit
 * here, which is precisely the kind of two-place change that gets forgotten.
 */
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|uploads|favicon.ico|.*\\.[^/]+$).*)'],
};
