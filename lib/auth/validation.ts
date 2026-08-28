/**
 * Sign-up and sign-in input validation (SPEC-005, "Validation rules").
 *
 * Pure functions over strings — no database, no cookies, no `next/*` imports.
 * That is what lets the server action, the unit suite and (should a later
 * slice want it) a client-side hint all reach the same verdict, and it is why
 * the rules live here rather than inline in `app/(auth)/actions.ts`.
 *
 * ── The shape of a failure ─────────────────────────────────────────────────
 * SPEC-005's oracle asks for a "field-level error", so validation returns a
 * `{ field, message }` list rather than throwing on the first problem. A form
 * that reports one error, gets it fixed, then reports the next is a form the
 * user fills in three times; collecting every failure means one round trip.
 *
 * ── What is deliberately NOT validated here ────────────────────────────────
 * Uniqueness of email and handle. Both are decided by the database's unique
 * index, because any check here would be a read that another request can
 * invalidate before the write lands. `signUp` catches the constraint violation
 * instead — the check and the guarantee are then the same thing.
 */

import { isWeakPassword } from './weak-passwords';

/** SPEC-005 / SPEC-004: `^[a-z0-9_]{3,24}$`. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

/** SPEC-005: "Password: 8–200 chars". */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** SPEC-004's display name bounds, re-stated so sign-up rejects before the repo throws. */
export const NAME_MIN = 1;
export const NAME_MAX = 60;

/**
 * Handles the route map claims for itself (SPEC-005).
 *
 * These are reserved because `/@admin` and `/settings` must never be
 * ambiguous, and because a user called `admin` is a social-engineering
 * primitive. The list is exactly the seven SPEC-005 names — no more, so the
 * oracle's enumeration and this constant cannot drift apart.
 */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
  'admin', 'api', 'me', 'settings', 'new', 'search', 'tag',
]);

const RESERVED = new Set(RESERVED_HANDLES);

/** The fields a sign-up form can fail on. */
export type AuthField = 'email' | 'password' | 'name' | 'handle';

export interface FieldError {
  field: AuthField;
  message: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  handle: string;
}

/** The normalised, validated form of a sign-up — what `signUp` writes. */
export interface NormalizedSignUp {
  email: string;
  password: string;
  name: string;
  handle: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

/**
 * A pragmatic email shape check: one `@`, something either side, a dot in the
 * domain, no whitespace.
 *
 * Deliberately not RFC 5322. The full grammar accepts things no mail system
 * routes and is famously unreadable, and this app never sends mail (SPEC-005:
 * "no email delivery"), so an address is an identifier, not a delivery target.
 * The job here is to reject typos and obvious junk, and to guarantee the value
 * is safe to use as a natural key — which the whitespace and length bounds do.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export const EMAIL_MAX = 254; // RFC 5321 §4.5.3.1.3 path limit

/** SPEC-005: "normalized to lowercase + trimmed before uniqueness check". */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lowercase + trim, matching `lib/db/users.ts` so both decide on one form. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

export function validateEmail(email: string): FieldError | null {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0) return { field: 'email', message: 'Enter your email address.' };
  if (normalized.length > EMAIL_MAX) {
    return { field: 'email', message: 'That email address is too long.' };
  }
  if (!EMAIL_PATTERN.test(normalized)) {
    return { field: 'email', message: 'Enter a valid email address.' };
  }
  return null;
}

/**
 * SPEC-005: 8–200 chars, denylist checked, and no composition rules.
 *
 * The password is NOT trimmed. Leading and trailing spaces are legitimate
 * characters in a passphrase, and trimming here would mean the string that
 * gets hashed at sign-up differs from the one typed at sign-in — the classic
 * "my password stopped working" bug. Only the denylist comparison normalises,
 * and it does so on a copy.
 */
export function validatePassword(password: string): FieldError | null {
  if (password.length < PASSWORD_MIN) {
    return {
      field: 'password',
      message: `Use at least ${PASSWORD_MIN} characters.`,
    };
  }
  if (password.length > PASSWORD_MAX) {
    return {
      field: 'password',
      message: `Use at most ${PASSWORD_MAX} characters.`,
    };
  }
  if (isWeakPassword(password)) {
    return {
      field: 'password',
      message: 'That password is too common. Choose something harder to guess.',
    };
  }
  return null;
}

export function validateName(name: string): FieldError | null {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN) return { field: 'name', message: 'Enter your name.' };
  if (trimmed.length > NAME_MAX) {
    return { field: 'name', message: `Use at most ${NAME_MAX} characters.` };
  }
  return null;
}

/**
 * SPEC-005: `^[a-z0-9_]{3,24}$`, with the reserved list rejected.
 *
 * The reserved check runs AFTER the pattern check so a handle that is both
 * malformed and reserved reports the malformation — the more actionable of the
 * two — and so the reserved list never has to worry about casing, since a
 * handle that reaches it has already been normalised and matched.
 */
export function validateHandle(handle: string): FieldError | null {
  const normalized = normalizeHandle(handle);
  if (normalized.length === 0) return { field: 'handle', message: 'Choose a handle.' };
  if (!HANDLE_PATTERN.test(normalized)) {
    return {
      field: 'handle',
      message: 'Handles are 3–24 characters, using lowercase letters, numbers and underscores.',
    };
  }
  if (RESERVED.has(normalized)) {
    return { field: 'handle', message: 'That handle is reserved. Choose another.' };
  }
  return null;
}

/** True when the handle is one of SPEC-005's seven reserved names. */
export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(normalizeHandle(handle));
}

/**
 * Validate a whole sign-up, returning either the normalised values or every
 * field-level error at once.
 */
export function validateSignUp(input: SignUpInput): ValidationResult<NormalizedSignUp> {
  const errors = [
    validateEmail(input.email),
    validatePassword(input.password),
    validateName(input.name),
    validateHandle(input.handle),
  ].filter((e): e is FieldError => e !== null);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      email: normalizeEmail(input.email),
      password: input.password,
      name: input.name.trim(),
      handle: normalizeHandle(input.handle),
    },
  };
}

/**
 * Sign-in's only input check.
 *
 * Notice what it does NOT do: it does not run `validatePassword`. Applying the
 * sign-up rules at sign-in would leak — "use at least 8 characters" told to
 * someone typing a 5-character password confirms nothing exists at that
 * address, but "that password is too common" on a stored account absolutely
 * does, and any per-field message here splits the single generic failure
 * SPEC-005 requires into a signal. Sign-in checks only that both boxes have
 * something in them; everything else is the one opaque outcome.
 */
export function validateSignInShape(email: string, password: string): boolean {
  return normalizeEmail(email).length > 0 && password.length > 0;
}

// ---------------------------------------------------------------------------
// Auth outcomes
// ---------------------------------------------------------------------------

/**
 * The shape a credential form gets back when the action does NOT redirect.
 *
 * ── Why this lives here rather than beside the actions ─────────────────────
 * `app/(auth)/actions.ts` carries the `'use server'` directive, and Next
 * permits a "use server" module to export ONLY async functions — a plain
 * `export const` there is a build error, not a lint warning. So the constants
 * and types the actions share with the pages and the tests have to live in an
 * ordinary module, and this is the one that already owns `FieldError` and
 * every other field-level message.
 *
 * `status` carries the HTTP semantics the oracle asks about — notably 429 for
 * a rate-limited sign-in — even though a Server Action's transport is always a
 * 200. Without it, "a 6th failed sign-in returns HTTP 429" would have nowhere
 * to be observed: the concept has to exist in the return value or it does not
 * exist at all.
 */
export interface AuthFormState {
  /** Per-field problems, for rendering next to the input that caused them. */
  errors: FieldError[];
  /** A whole-form problem — sign-in's single generic failure lives here. */
  formError: string | null;
  /** 200 (nothing wrong), 400 (invalid), 401 (bad credentials), 429 (limited). */
  status: 200 | 400 | 401 | 429;
}

/**
 * The initial state `useActionState` is seeded with.
 *
 * Frozen because it is shared by every form on every request: an action that
 * mutated `prevState.errors` instead of returning a new object would corrupt
 * the seed for everyone else, and the resulting bug would look like one user's
 * validation errors appearing on another user's form.
 */
export const EMPTY_FORM_STATE: AuthFormState = Object.freeze({
  errors: Object.freeze([] as FieldError[]) as FieldError[],
  formError: null,
  status: 200,
});

/**
 * The ONE message every sign-in failure returns (SPEC-005: "Sign-in failure
 * returns a single generic message — never 'no such user' vs 'wrong
 * password'").
 *
 * A single constant rather than a repeated literal, because the oracle asserts
 * the two failure paths are *byte-identical* — and two copies of a sentence
 * drift the moment somebody improves the wording of one of them.
 */
export const GENERIC_SIGNIN_ERROR = 'Email or password is incorrect.';

/**
 * What a rate-limited attempt says.
 *
 * Distinct from the credential failure by necessity: a user locked out for 15
 * minutes has to be told why, and this message reveals nothing about whether
 * the account exists — it is the same answer for an address that was never
 * registered.
 */
export const RATE_LIMITED_ERROR = 'Too many sign-in attempts. Wait a few minutes and try again.';

/**
 * Failure codes carried back to `/signin` in the query string.
 *
 * `/signin` is a Server Component with a plain `<form action=...>`, so there is
 * no client state to hold a returned `AuthFormState` — the outcome has to
 * survive a redirect, and a short code is what survives cleanly.
 *
 * The MESSAGES stay here, mapped from the code by `signInErrorMessage`, rather
 * than being put in the URL themselves. Two reasons, and the first is the
 * sealed criterion: the wrong-password and unknown-email failures must be
 * byte-identical, which is trivially true when both render the same constant
 * and fragile when both build a string from a parameter. The second is that a
 * message in the URL is a message an attacker can choose —
 * `/signin?error=Your+account+was+deleted` would be a phishing surface for
 * free.
 */
export const SIGNIN_ERROR_CODE = { invalid: 'invalid', limited: 'limited' } as const;
export type SignInErrorCode = (typeof SIGNIN_ERROR_CODE)[keyof typeof SIGNIN_ERROR_CODE];

/** Map a code from the URL to its message, ignoring anything unrecognised. */
export function signInErrorMessage(code: string | undefined): string | null {
  if (code === SIGNIN_ERROR_CODE.limited) return RATE_LIMITED_ERROR;
  if (code === SIGNIN_ERROR_CODE.invalid) return GENERIC_SIGNIN_ERROR;
  return null;
}
