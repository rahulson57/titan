'use server';

/**
 * The three credential actions (SPEC-005, "Routes & actions").
 *
 * | Route/Action | Request                            | Response                       |
 * |--------------|------------------------------------|--------------------------------|
 * | `/signup`    | `{ email, password, name, handle }`| redirect `/` + session cookie  |
 * | `/signin`    | `{ email, password }`              | redirect `next` or `/` + cookie|
 * | Sign out     | —                                  | deletes Session row, clears it |
 *
 * ── CSRF ───────────────────────────────────────────────────────────────────
 * There is no token here, and that is SPEC-005's decision, not an omission:
 * "Next Server Actions' built-in origin check + `sameSite=lax` — No custom
 * token needed for same-origin actions." A Server Action is a POST to an
 * opaque generated id that Next refuses when `Origin` does not match `Host`,
 * so a cross-site form has nothing to submit to. `sameSite=lax` is the second
 * layer: the session cookie is not attached to a cross-site POST at all.
 *
 * ── Why the constants are NOT here ─────────────────────────────────────────
 * Next permits a `'use server'` module to export ONLY async functions — a
 * plain `export const` is a build error, not a lint warning, and it fails the
 * whole route rather than the line. So `AuthFormState`, `GENERIC_SIGNIN_ERROR`
 * and the rest live in `lib/auth/validation.ts` and are re-imported here. Every
 * export below is an async function, and must stay one.
 *
 * ── Why `redirect()` is never inside a `try` ───────────────────────────────
 * `redirect()` signals by throwing a `NEXT_REDIRECT` error that the framework
 * catches upstream. A `try { ... } catch { }` wrapped around it swallows the
 * redirect and the action silently returns nothing — the form appears to hang
 * with no error. Every `redirect()` below is therefore in the function's tail
 * position, outside any catch, and the code is shaped around that constraint.
 */

import { redirect } from 'next/navigation';

import { createUser, findUserByEmail, findUserByHandle } from '../../lib/db/users';
import { safeNextPath } from '../../lib/auth/config';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../lib/auth/password';
import * as rateLimit from '../../lib/auth/rate-limit';
import { endSession, startSession } from '../../lib/auth/session';
import {
  type AuthFormState,
  type FieldError,
  EMPTY_FORM_STATE,
  GENERIC_SIGNIN_ERROR,
  RATE_LIMITED_ERROR,
  SIGNIN_ERROR_CODE,
  normalizeEmail,
  validateSignInShape,
  validateSignUp,
} from '../../lib/auth/validation';

function invalid(errors: FieldError[]): AuthFormState {
  return { errors, formError: null, status: 400 };
}

function field(name: FieldError['field'], message: string): AuthFormState {
  return invalid([{ field: name, message }]);
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------

/**
 * Create an account and sign the new user in.
 *
 * Uniqueness is checked twice and neither check is redundant. The `findUserBy*`
 * lookups exist to produce a *field-level* error — "that handle is taken",
 * attached to the handle input, which is what the form needs to be usable. The
 * database's unique index is what actually guarantees it: between the lookup
 * and the insert, another request can claim the same handle, and only the
 * constraint closes that window. The `catch` below turns the resulting
 * violation back into the same field error, so the race and the ordinary case
 * are indistinguishable to the user.
 *
 * Unlike sign-in, sign-up DOES disclose that an email is registered. That is a
 * deliberate, bounded trade: a sign-up form cannot both tell you your chosen
 * identity is unavailable and keep secret that it is taken. SPEC-005 requires
 * non-enumeration of *sign-in* specifically, which is the path an attacker can
 * probe without side effects.
 */
export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = validateSignUp({
    email: text(formData, 'email'),
    password: text(formData, 'password'),
    name: text(formData, 'name'),
    handle: text(formData, 'handle'),
  });

  if (!parsed.ok) return invalid(parsed.errors);
  const { email, password, name, handle } = parsed.value;

  if (await findUserByEmail(email)) {
    return field('email', 'An account with that email already exists.');
  }
  if (await findUserByHandle(handle)) {
    return field('handle', 'That handle is taken. Choose another.');
  }

  let userId: string;
  try {
    const user = await createUser({
      email,
      handle,
      name,
      passwordHash: await hashPassword(password),
    });
    userId = user.id;
  } catch (error) {
    // Prisma's unique-constraint violation. Reached only when a concurrent
    // sign-up claimed the same email or handle between the checks above and
    // this insert — rare, but the only thing standing between that race and a
    // 500 shown to a user who did nothing wrong.
    const target = uniqueConstraintTarget(error);
    if (target === 'email') return field('email', 'An account with that email already exists.');
    if (target === 'handle') return field('handle', 'That handle is taken. Choose another.');
    throw error;
  }

  await startSession(userId);
  redirect('/');
}

/**
 * Which column a Prisma P2002 names, or `null` if this was not one.
 *
 * Read structurally rather than by matching the message text: Prisma's error
 * strings are not a stable interface, and a version bump that reworded them
 * would turn a handled race into a 500 with no test failing first.
 */
function uniqueConstraintTarget(error: unknown): 'email' | 'handle' | null {
  if (!error || typeof error !== 'object') return null;
  if ((error as { code?: string }).code !== 'P2002') return null;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  if (fields.some((f) => f.includes('email'))) return 'email';
  if (fields.some((f) => f.includes('handle'))) return 'handle';
  return null;
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/**
 * Verify credentials and start a session.
 *
 * The order of operations is the security-relevant part:
 *
 *  1. **Rate limit first.** Checked before the password is verified, so a
 *     locked-out attacker cannot make us spend ~19 MiB and two argon2 passes
 *     per guess. A limiter that runs after verification rate-limits the
 *     *answer* while leaving the *cost* fully available as a DoS lever.
 *  2. **Always verify a hash.** When no user matches, `verifyAgainstDummy`
 *     runs a real argon2 verification against a real hash that cannot match.
 *     Both failure paths therefore pay the same memory-hard cost, which is what
 *     makes SPEC-005's "within 50 ms of each other's mean over 20 runs" true.
 *     Identical *messages* alone do not achieve it — the clock is the leak.
 *  3. **Record the failure, then return the one message.** Both branches
 *     return `GENERIC_SIGNIN_ERROR`, the same constant, so they are
 *     byte-identical by construction rather than by careful copy-editing.
 *
 * On success the window is cleared, so a user who mistyped four times and then
 * succeeded is not one slip away from a lockout.
 */
export async function signIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const rawEmail = text(formData, 'email');
  const password = text(formData, 'password');
  const next = safeNextPath(text(formData, 'next') || null);
  const email = normalizeEmail(rawEmail);

  if (!validateSignInShape(rawEmail, password)) {
    return { errors: [], formError: GENERIC_SIGNIN_ERROR, status: 401 };
  }

  if (rateLimit.check(email).limited) {
    return { errors: [], formError: RATE_LIMITED_ERROR, status: 429 };
  }

  const user = await findUserByEmail(email);
  const ok = user
    ? await verifyPassword(user.passwordHash, password)
    : await verifyAgainstDummy(password);

  if (!ok || !user) {
    rateLimit.recordFailure(email);
    return { errors: [], formError: GENERIC_SIGNIN_ERROR, status: 401 };
  }

  rateLimit.clear(email);
  await startSession(user.id);
  redirect(next);
}

/**
 * The transport wrapper `/signin`'s form posts to.
 *
 * All the logic is in `signIn` above, which returns a value and is therefore
 * directly testable — `auth-enumeration.test.ts` times both of its failure
 * paths without a browser. This wrapper does nothing but turn that value into
 * a redirect, so the untested-by-construction surface is six lines with no
 * branches worth hiding a bug in.
 *
 * Note the deliberate omission: the submitted email is NOT echoed back in the
 * redirect. It would spare the user one retype and would also write their
 * address into browser history, the referrer of every subsequent request, and
 * any access log — a poor trade on the one form where the input is an
 * identifier.
 */
export async function signInFromForm(formData: FormData): Promise<void> {
  const result = await signIn(EMPTY_FORM_STATE, formData);

  // Reached only when `signIn` did NOT redirect, i.e. on failure.
  const code =
    result.status === 429 ? SIGNIN_ERROR_CODE.limited : SIGNIN_ERROR_CODE.invalid;
  const next = safeNextPath(
    typeof formData.get('next') === 'string' ? (formData.get('next') as string) : null,
  );
  const params = new URLSearchParams({ error: code });
  if (next !== '/') params.set('next', next);
  redirect(`/signin?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/**
 * Delete the Session row and clear the cookie (SPEC-005).
 *
 * Because the row is the session, this genuinely revokes: any other browser
 * still holding that cookie is anonymous on its next request. That is the
 * property DEC-005 chose database sessions for, and the reason the oracle can
 * assert it at all.
 *
 * Takes no arguments so it can be used directly as `<form action={signOut}>`
 * from the app shell (SPEC-011) without a wrapper.
 */
export async function signOut(): Promise<void> {
  await endSession();
  redirect('/');
}
