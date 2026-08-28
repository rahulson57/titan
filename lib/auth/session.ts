/**
 * Sessions and server-side authorization (SPEC-005).
 *
 * This module is the answer to the sentence in TASK-004's own description —
 * "the server-side authorization checks every mutating action calls". Later
 * slices own the editor, the media uploader, the profile form and the
 * engagement mutations; every one of them enforces its ownership rule by
 * calling something here, so the rules exist once and are tested once.
 *
 * ── The layering, and why it is worth the extra file ───────────────────────
 * Everything in this module is pure except the four functions at the bottom
 * that touch `next/headers` or the database. That split is not tidiness: a
 * predicate that reaches for `cookies()` can only be exercised inside a
 * request, so it can only be tested through a browser — and browser tests are
 * exactly where an authorization bug is least likely to be noticed, because
 * the assertion is usually "the page looked right".
 *
 * Keeping `ownsArticle`, `canViewArticle` and `authorizationFor` as functions
 * of plain values means `authz-article.test.ts` can enumerate anonymous /
 * author / stranger against DRAFT / PUBLISHED exhaustively, in milliseconds,
 * with no server running.
 *
 * ── 404 for a draft, not 403 ───────────────────────────────────────────────
 * SPEC-005 is specific: "Drafts are visible ONLY to their author —
 * `/article/[slug]` returns 404 (not 403) for a DRAFT requested by anyone
 * else." The difference matters. A 403 confirms the slug names something real,
 * which turns a guessable URL into an oracle that leaks an author's unpublished
 * titles one guess at a time. A 404 says only "there is nothing here", which is
 * the honest answer to someone with no right to know otherwise.
 *
 * A mutation is the opposite case, and the spec asks for 403 there: the caller
 * is already authenticated and already knows the article exists (they had to
 * name its id), so hiding behind a 404 would obscure a real permission error
 * for no privacy gain.
 */

import type { ArticleRecord } from '../db/articles';
import type { UserRecord } from '../db/users';
import { createSession, deleteSession, findSessionUser } from '../db/users';
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  sessionCookieOptions,
  sessionExpiry,
} from './config';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The user as auth exposes them (SPEC-005: `auth()` returns
 * `{ user: { id, handle, name, avatarPath } } | null`).
 *
 * Deliberately NOT the full `UserRecord`. This object is handed to server
 * components and, from there, into props that may cross to the client — and
 * `UserRecord` carries `passwordHash` and `email`. Projecting to exactly the
 * four fields the spec names means a careless `<Nav user={session.user} />`
 * cannot serialise a password hash into the HTML payload. The narrow type is
 * the control; nobody has to remember to strip anything.
 */
export interface SessionUser {
  id: string;
  handle: string;
  name: string;
  avatarPath: string | null;
}

export interface Session {
  user: SessionUser;
}

/** Project a stored user down to what a session is allowed to expose. */
export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    avatarPath: user.avatarPath,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An authorization outcome that carries the status the HTTP surface must
 * answer with, so the mapping from rule to status code lives with the rule
 * rather than being re-decided at each of the dozen call sites.
 */
export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** No session at all where one is required. */
export class NotAuthenticatedError extends AuthError {
  constructor() {
    super(401, 'You must be signed in to do that.');
    this.name = 'NotAuthenticatedError';
  }
}

/** A session that is not permitted to act on this resource (SPEC-005: 403). */
export class ForbiddenError extends AuthError {
  constructor(message = 'You do not have permission to do that.') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

/** Absent, or present-but-not-visible-to-you (SPEC-005's draft rule: 404). */
export class NotVisibleError extends AuthError {
  constructor(message = 'Not found.') {
    super(404, message);
    this.name = 'NotVisibleError';
  }
}

// ---------------------------------------------------------------------------
// Pure authorization rules
// ---------------------------------------------------------------------------

/** The subset of an article these rules actually read. */
export interface OwnedArticle {
  authorId: string;
  status: string;
}

/** SPEC-005: "Only `article.authorId === session.user.id` may edit, publish, or delete". */
export function ownsArticle(user: SessionUser | null, article: OwnedArticle): boolean {
  return user !== null && user.id === article.authorId;
}

/**
 * SPEC-005: "Drafts are visible ONLY to their author."
 *
 * A published article is visible to everyone including anonymous readers; a
 * draft is visible to its author and to nobody else.
 */
export function canViewArticle(user: SessionUser | null, article: OwnedArticle): boolean {
  if (article.status === 'PUBLISHED') return true;
  return ownsArticle(user, article);
}

/** SPEC-005: "Only the owning user may edit their profile". */
export function ownsProfile(user: SessionUser | null, targetUserId: string): boolean {
  return user !== null && user.id === targetUserId;
}

/**
 * SPEC-005: "Only the owning user may ... upload to their avatar/cover paths."
 *
 * SPEC-006 owns the upload pipeline and the on-disk layout; this only knows the
 * rule it must satisfy — a per-user directory whose segment is the user's id.
 * The traversal check is here rather than in the uploader because it is an
 * authorization property: `public/uploads/<other-user>/../<me>/x.webp` names a
 * path inside the caller's own directory while *claiming* another user's
 * segment, and a plain `startsWith` on the raw string would wave it through.
 */
export function ownsUploadPath(user: SessionUser | null, path: string): boolean {
  if (!user) return false;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return false;
  const segments = normalized.split('/').filter(Boolean);
  const uploadsAt = segments.indexOf('uploads');
  if (uploadsAt === -1) return false;
  return segments[uploadsAt + 1] === user.id;
}

/**
 * The one decision function for acting on an article, returning a status
 * rather than throwing.
 *
 * The read and write intents answer differently on purpose, and SPEC-005 sets
 * both:
 *
 *   - a **read** of a draft by anyone else is **404** — "Drafts are visible
 *     ONLY to their author — `/article/[slug]` returns 404 (not 403) for a
 *     DRAFT requested by anyone else". A 403 there would confirm the slug
 *     names something real, turning a guessable URL into an oracle that leaks
 *     unpublished titles one guess at a time.
 *
 *   - a **write** by a signed-in stranger is **403**, flatly, whatever the
 *     article's status — "A POST to the article-update action for an article
 *     owned by another user returns a 403". The draft/published distinction
 *     deliberately does NOT apply here, and it is worth saying why, because
 *     extending the 404 rule to writes looks like the more careful choice and
 *     is not: mutations are addressed by article **id**, a 26-character
 *     random cuid2, not by a human-guessable slug. A caller holding an id
 *     already knows the article exists, so answering 404 would hide a real
 *     permission error behind a lie and buy no privacy at all.
 *
 *   - a **write** by an anonymous visitor is **401**, for the same reason:
 *     they cannot have reached a valid id by probing, so "sign in" is both the
 *     honest answer and the actionable one.
 */
export type AuthorizationStatus = 200 | 401 | 403 | 404;

export function authorizationFor(
  user: SessionUser | null,
  article: OwnedArticle,
  intent: 'read' | 'write',
): AuthorizationStatus {
  if (intent === 'read') return canViewArticle(user, article) ? 200 : 404;
  if (ownsArticle(user, article)) return 200;
  return user === null ? 401 : 403;
}

// ---------------------------------------------------------------------------
// Enforcing wrappers
// ---------------------------------------------------------------------------

/** Narrow a possibly-absent session, or throw 401. */
export function requireUser(session: Session | null): SessionUser {
  if (!session) throw new NotAuthenticatedError();
  return session.user;
}

/** Throw unless this user may read this article (404 for a stranger's draft). */
export function requireVisibleArticle<T extends OwnedArticle>(
  user: SessionUser | null,
  article: T | null,
): T {
  if (!article || !canViewArticle(user, article)) throw new NotVisibleError();
  return article;
}

/** Throw unless this user owns this article (403), or may not see it (404). */
export function requireArticleOwner<T extends OwnedArticle>(
  user: SessionUser | null,
  article: T | null,
): T {
  if (!article) throw new NotVisibleError();
  const status = authorizationFor(user, article, 'write');
  if (status === 404) throw new NotVisibleError();
  if (status === 401) throw new NotAuthenticatedError();
  if (status === 403) throw new ForbiddenError();
  return article;
}

/** Throw unless this user is the profile's owner (SPEC-005). */
export function requireProfileOwner(user: SessionUser | null, targetUserId: string): SessionUser {
  if (!user) throw new NotAuthenticatedError();
  if (!ownsProfile(user, targetUserId)) throw new ForbiddenError();
  return user;
}

/** The shape a guarded mutation returns instead of throwing. */
export type GuardResult<T> =
  | { ok: true; status: 200; value: T }
  | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Run a mutation only if the caller owns the article.
 *
 * This is the shape SPEC-007/009/010's actions are meant to consume, and the
 * reason it takes the mutation as a callback rather than merely answering
 * yes/no: a guard that returns a boolean can be checked and then ignored, and
 * the resulting bug — a write that ran despite a failed check — is invisible in
 * review because the check is *right there*, three lines above the write.
 *
 * Here the write is unreachable unless the check passed. "Returns 403 and
 * leaves the row unchanged" (SPEC-005's oracle) is then a structural property
 * of the combinator rather than a discipline each action has to maintain, and
 * `authz-article.test.ts` proves it by reading the row back after a rejected
 * call.
 *
 * `loadArticle` is injected rather than imported so this stays testable
 * against a fixture and so the caller — who has usually already loaded the
 * article — is not forced into a second query.
 */
export async function guardArticleMutation<T>(
  user: SessionUser | null,
  articleId: string,
  loadArticle: (id: string) => Promise<OwnedArticle | null>,
  mutate: (article: OwnedArticle) => Promise<T>,
): Promise<GuardResult<T>> {
  const article = await loadArticle(articleId);
  if (!article) return { ok: false, status: 404, error: 'Not found.' };

  const status = authorizationFor(user, article, 'write');
  if (status !== 200) {
    return {
      ok: false,
      status,
      error:
        status === 403
          ? 'You do not have permission to do that.'
          : status === 401
            ? 'You must be signed in to do that.'
            : 'Not found.',
    };
  }

  return { ok: true, status: 200, value: await mutate(article) };
}

// ---------------------------------------------------------------------------
// Request-bound session handling
// ---------------------------------------------------------------------------

/**
 * The cookie jar, imported lazily.
 *
 * `next/headers` throws the moment it is evaluated outside a request scope,
 * which would make this module unimportable from a plain Node test — and the
 * pure rules above are the part most worth testing. A dynamic import confines
 * that constraint to the three functions that genuinely need a request.
 */
async function cookieStore() {
  const { cookies } = await import('next/headers');
  return cookies();
}

/**
 * Resolve the current session (SPEC-005's `auth()`).
 *
 * Returns `null` for: no cookie, an unknown id, and an expired row —
 * `findSessionUser` treats expiry as absence, so a stale cookie is anonymous
 * rather than an error. Sign-out deletes the row, which is what makes the
 * oracle's "a subsequent request with the stale cookie is treated as anonymous"
 * true of a cookie the browser may still be holding.
 *
 * Every authenticated request costs one indexed SELECT on the session's primary
 * key. DEC-005 accepts that in writing as the price of revocability.
 */
export async function auth(): Promise<Session | null> {
  const store = await cookieStore();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const user = await findSessionUser(sessionId);
  if (!user) return null;

  return { user: toSessionUser(user) };
}

/** `auth()`, but throws 401 instead of returning null. */
export async function requireAuth(): Promise<SessionUser> {
  return requireUser(await auth());
}

/**
 * Create a session row for `userId` and set the cookie.
 *
 * The id is generated by `lib/db/ids.ts`'s `createSessionId` — 32 bytes from
 * the platform CSPRNG, hex-encoded — and is never derived from anything about
 * the user. A session id IS the capability; deriving it from a user id or a
 * timestamp would make it guessable, and no amount of cookie hardening
 * recovers from that.
 */
export async function startSession(userId: string, now: Date = new Date()): Promise<string> {
  const session = await createSession({ userId, expiresAt: sessionExpiry(now), createdAt: now });
  const store = await cookieStore();
  store.set(SESSION_COOKIE, session.id, sessionCookieOptions(now));
  return session.id;
}

/**
 * Delete the session row and clear the cookie.
 *
 * The row goes first. If the process died between the two steps, the surviving
 * order leaves a browser holding a cookie whose row is gone — which `auth()`
 * already reads as anonymous. The opposite order would leave a live session row
 * with no way for the user to reach it and no way to revoke it, which is the
 * failure that actually matters.
 */
export async function endSession(): Promise<void> {
  const store = await cookieStore();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (sessionId) await deleteSession(sessionId);
  store.set(SESSION_COOKIE, '', clearedSessionCookieOptions());
}

/** Read the raw session id from the request, without resolving it. */
export async function currentSessionId(): Promise<string | null> {
  const store = await cookieStore();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export type { ArticleRecord };
