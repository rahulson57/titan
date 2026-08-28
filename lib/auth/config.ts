/**
 * The auth cookie and session contract (SPEC-005), in one place.
 *
 * Everything here is a value the spec fixes by name, kept as a constant so the
 * tests can assert the contract rather than re-typing it: a cookie whose name
 * or `sameSite` drifted would still work perfectly in the browser and would
 * silently void the property the spec is actually buying.
 *
 * ── Why this is not a NextAuth config ──────────────────────────────────────
 * SPEC-005's Mechanism table names "Auth.js (NextAuth v5) Credentials
 * provider" on one row and "Database session, Session row + opaque 32-byte
 * random id" on the next. Those two rows cannot both hold: Auth.js supports
 * its Credentials provider only under `strategy: 'jwt'`, and never asks the
 * adapter to create a session row for it.
 *
 * The sealed acceptance oracle decides which half survives, and it picks the
 * database twice over — "creates exactly one Session row", and "signing out
 * deletes the Session row and a subsequent request with the stale cookie is
 * treated as anonymous". A stateless JWT stays valid until it expires, so
 * under the other reading "signed out" would be a client-side fiction that no
 * test could honestly assert. That is precisely the property DEC-005 chose
 * database sessions FOR, in its own words.
 *
 * So the session is an opaque 32-byte id in a `titan.session` cookie, resolved
 * against the `Session` table on every request — which is what every other row
 * of SPEC-005's own table already describes. This was raised with the
 * coordinator before it was built (MSG-2237 / MSG-2241), not decided quietly.
 */

/** SPEC-005: the cookie is named `titan.session`. */
export const SESSION_COOKIE = 'titan.session';

/** SPEC-005: `maxAge` 30 days. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

/**
 * The cookie's flags.
 *
 * `httpOnly` is the one the oracle checks directly ("`document.cookie` in the
 * browser does NOT contain `titan.session`"), and it is the reason a stolen
 * XSS payload cannot lift a session: script has no read path to the value.
 *
 * `sameSite: 'lax'` rather than `'strict'` is a deliberate usability call that
 * SPEC-005 makes by name. Under `strict`, following a link to an article from
 * anywhere off-site arrives signed out, which on a reading product is the
 * wrong first impression. `lax` still withholds the cookie from cross-site
 * POSTs, which is the CSRF-relevant half; SPEC-005 pairs it with Server
 * Actions' built-in origin check rather than a custom token.
 *
 * `secure` follows `NODE_ENV === 'production'` exactly as SPEC-005 specifies.
 * Hard-coding `true` would be strictly "more secure" and would also break the
 * entire product, because SPEC-001 serves plain http on localhost and a
 * `Secure` cookie is never sent over http — sign-in would appear to succeed
 * and every following request would be anonymous.
 */
export function sessionCookieOptions(now: Date = new Date()) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: new Date(now.getTime() + SESSION_MAX_AGE_MS),
  } as const;
}

/** The same flags with the lifetime zeroed — how sign-out clears the cookie. */
export function clearedSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    expires: new Date(0),
  } as const;
}

/** When a session created now must stop being accepted. */
export function sessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_MAX_AGE_MS);
}

/**
 * Routes that require a signed-in user (SPEC-005's authorization rules, as
 * seen by the router).
 *
 * Kept here rather than in `middleware.ts` so the list is importable by tests
 * and by the sign-in redirect, and so adding a protected surface is a one-line
 * change in a file that is unit-tested. Matching is on whole path segments —
 * `/editor` covers `/editor/abc123` but NOT `/editors`, which a raw
 * `startsWith` would wrongly claim.
 */
export const PROTECTED_PREFIXES: readonly string[] = Object.freeze([
  '/editor',
  '/settings',
  '/bookmarks',
]);

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isProtectedPath(pathname: string): boolean {
  return matchesPrefix(pathname, PROTECTED_PREFIXES);
}

/** The query parameter carrying where to return to after signing in. */
export const NEXT_PARAM = 'next';

/** Matches any C0/C1 control character, including the CR and LF used to split headers. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Constrain a `?next=` destination to a same-origin path.
 *
 * This is an open-redirect guard, and it is the reason the parameter is not
 * simply handed to `redirect()`. `?next=https://evil.example/login` would
 * otherwise turn our own sign-in form into a credible phishing hop: the user
 * signs in on the real site and is then handed to an attacker's replica.
 *
 * Rejected: anything not starting with a single `/` (absolute URLs, and
 * scheme-relative `//evil.example`, which browsers treat as absolute);
 * anything containing a backslash, because some parsers normalise
 * `/\evil.example` into that same scheme-relative form; and any control
 * character, which is the header-injection half of the same problem.
 *
 * A rejected value falls back to `/` rather than raising. A malformed `next`
 * is a broken link, not a reason to fail an otherwise valid sign-in.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  if (next.includes('\\')) return fallback;
  if (CONTROL_CHARACTERS.test(next)) return fallback;
  return next;
}
