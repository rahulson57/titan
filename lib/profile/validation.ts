/**
 * Profile-settings validation, and the guarded write it gates (SPEC-010).
 *
 * | Field   | Rule                                                                    |
 * |---------|-------------------------------------------------------------------------|
 * | name    | 1–60 chars, required                                                    |
 * | handle  | `^[a-z0-9_]{3,24}$`, unique, not reserved; changing it changes the URL   |
 * | bio     | 0–220 chars, plain text only (no markup rendered)                       |
 * | avatar  | `/api/upload?kind=avatar` → replaces `avatarPath`                        |
 * | cover   | `/api/upload?kind=cover` → replaces `coverPath`                          |
 * | socials | validated per `lib/profile/socials.ts`                                   |
 *
 * ── Why the WRITE lives here and not in the Server Action ─────────────────
 * `app/settings/profile/actions.ts` carries `'use server'`, and every export of
 * a `'use server'` module is a callable Server Action: Next publishes an id for
 * it, and anything that can POST can invoke it with arguments of its choosing.
 *
 * That makes `saveProfile(actor, …)` — which takes the *caller's identity as a
 * parameter* — the one function that must never be exported from such a module.
 * An attacker who called it directly would simply pass the victim as `actor`
 * and satisfy the ownership check by supplying both sides of it. SPEC-010's
 * rule that "a signed-in user cannot write to any profile but their own —
 * enforced server-side in the action" would then hold in the code and not in
 * the product.
 *
 * So the action resolves the session itself, from the cookie, and hands the
 * result here; this module is ordinary and unexported to the network. The same
 * split is why `app/api/upload/route.ts` keeps `handleUpload(request, user)`
 * beside a `POST` that resolves the session — and it is what lets
 * `tests/unit/profile-authz.test.ts` prove "403, and both rows unchanged"
 * against a real database in milliseconds, with no browser and no request
 * scope. An authorization rule that can only be exercised through a browser is
 * one whose assertion is usually "the page looked right".
 *
 * ── Why `targetUserId` exists at all ──────────────────────────────────────
 * SPEC-010's oracle requires "a payload targeting user B's id returns HTTP 403
 * and leaves both rows unchanged". If the action derived the row to write from
 * the session alone, there would be no way to *express* that payload — the
 * criterion would be true and unobservable, and no test could ever exercise it.
 * The field is therefore accepted, compared once, and never used to build
 * anything: on the accepted path the write targets the session user's id, so a
 * hostile value can only ever produce a 403. This is the same shape DEC-034
 * approved for the upload handler's `userId` field, for the same reason.
 */

import {
  ForbiddenError,
  NotAuthenticatedError,
  ownsProfile,
  ownsUploadPath,
  type SessionUser,
} from '../auth/session';
import {
  HANDLE_PATTERN,
  NAME_MAX,
  NAME_MIN,
  isReservedHandle,
  normalizeHandle,
} from '../auth/validation';
import { BIO_MAX, findUserByHandle, updateUser, type UserRecord } from '../db/users';
import { KIND_DIRECTORY, PUBLIC_PREFIX } from '../media/store';
import { normalizeSocials, type SocialKey, type StoredSocials } from './socials';

export { BIO_MAX, HANDLE_PATTERN, NAME_MAX, NAME_MIN };

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Every field the settings form can fail on. */
export type ProfileField = 'name' | 'handle' | 'bio' | SocialKey | 'avatar' | 'cover';

export interface ProfileFieldError {
  field: ProfileField;
  message: string;
}

/** The raw strings a form submits. Every key is optional and unvalidated. */
export interface ProfileInput {
  name?: string;
  handle?: string;
  bio?: string;
  twitter?: string;
  github?: string;
  website?: string;
  /** A stored path from `/api/upload`, `''` to clear, or absent to leave alone. */
  avatarPath?: string;
  coverPath?: string;
}

/** What a validated form becomes — exactly what `updateUser` is handed. */
export interface NormalizedProfile {
  name: string;
  handle: string;
  bio: string | null;
  socials: StoredSocials;
  /** `undefined` means "not submitted, leave the column alone". */
  avatarPath?: string | null;
  coverPath?: string | null;
}

export type ProfileValidation =
  | { ok: true; value: NormalizedProfile }
  | { ok: false; errors: ProfileFieldError[] };

/**
 * The shape the form gets back.
 *
 * `status` carries the HTTP semantics SPEC-010's oracle asks about — 403 for a
 * cross-user save above all — even though a Server Action's transport is
 * always a 200. Without it, "returns HTTP 403" would have nowhere to be
 * observed: the concept has to exist in the return value or it does not exist.
 * `lib/auth/validation.ts`'s `AuthFormState` makes the same argument for 429.
 */
export interface ProfileFormState {
  errors: ProfileFieldError[];
  formError: string | null;
  status: 200 | 400 | 401 | 403;
  /**
   * ISO instant of the save that produced this state, or `null`.
   *
   * Present so a test can wait on "this page completed a save" without polling
   * the row from a second process — the precondition race that cost this
   * project a gate run on TASK-006.
   */
  savedAt: string | null;
  /** The handle the profile now lives under, so the form can re-point its link. */
  handle: string | null;
}

export const EMPTY_PROFILE_FORM_STATE: ProfileFormState = Object.freeze({
  errors: [],
  formError: null,
  status: 200,
  savedAt: null,
  handle: null,
});

function invalid(errors: ProfileFieldError[]): ProfileFormState {
  return { ...EMPTY_PROFILE_FORM_STATE, errors, status: 400 };
}

function field(name: ProfileField, message: string): ProfileFormState {
  return invalid([{ field: name, message }]);
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

/** SPEC-010: "name — 1–60 chars, required". */
export function validateName(name: string): ProfileFieldError | null {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN) return { field: 'name', message: 'Enter your name.' };
  if (trimmed.length > NAME_MAX) {
    return { field: 'name', message: `Use at most ${NAME_MAX} characters.` };
  }
  return null;
}

/**
 * SPEC-010: "handle — `^[a-z0-9_]{3,24}$`, unique, not in the reserved list".
 *
 * Uniqueness is NOT checked here, and that is not an omission: any read is
 * stale by the time the write lands. `saveProfile` looks the handle up to
 * produce a *field-level* message, and the database's unique index is what
 * actually guarantees it. The same division is documented at length in
 * `lib/auth/validation.ts`.
 *
 * The reserved list is `lib/auth/validation.ts`'s, imported rather than
 * restated. Two copies of a security list is one copy that gets updated.
 */
export function validateHandle(handle: string): ProfileFieldError | null {
  const normalized = normalizeHandle(handle);
  if (normalized.length === 0) return { field: 'handle', message: 'Choose a handle.' };
  if (!HANDLE_PATTERN.test(normalized)) {
    return {
      field: 'handle',
      message: 'Handles are 3–24 characters, using lowercase letters, numbers and underscores.',
    };
  }
  if (isReservedHandle(normalized)) {
    return { field: 'handle', message: 'That handle is reserved. Choose another.' };
  }
  return null;
}

/**
 * SPEC-010: "bio — 0–220 chars, plain text only (no markup rendered)".
 *
 * Length is the only rule. Markup is *not* stripped: "no markup rendered" is a
 * statement about the renderer, and React escapes text children by default, so
 * a bio containing `<b>` displays those five characters. Stripping here would
 * silently eat a `<` a person meant to type — an author writing about HTML is
 * not an attacker — and would make the stored value differ from what they saw
 * themselves type. The guarantee is kept where it belongs: nothing on the
 * profile page passes the bio to `dangerouslySetInnerHTML`.
 *
 * The bound is checked rather than truncated, because `updateUser` truncates
 * silently at 220 and a save that reports success while quietly discarding the
 * last character of a bio is worse than a rejection that says so. SPEC-010's
 * oracle agrees: a 221-char bio is "rejected with a field-level error and no
 * write".
 */
export function validateBio(bio: string): ProfileFieldError | null {
  // Count in code points, not UTF-16 units: `'😀'.length` is 2, so a bound
  // measured in units rejects a 110-emoji bio for being 220 characters long.
  const length = [...bio.trim()].length;
  if (length > BIO_MAX) {
    return { field: 'bio', message: `Use at most ${BIO_MAX} characters.` };
  }
  return null;
}

/**
 * A media path submitted by the form, checked against the uploader's contract.
 *
 * The value arrives from a hidden input that `AvatarUploader` fills in from
 * `/api/upload`'s response, which makes it attacker-controlled like any other
 * form field. Two independent rules apply, and neither alone is enough:
 *
 *   - it must be a path this `kind` of upload produces
 *     (`/uploads/avatars/…`, not `/uploads/covers/…`), so a cover cannot be
 *     installed as an avatar and nothing outside `/uploads` can be installed
 *     at all — a value of `/etc/passwd` or `https://tracker.example/pixel.gif`
 *     would otherwise become an `<img src>` on a public page;
 *   - `ownsUploadPath` must agree it is inside the acting user's own
 *     directory, which is what stops one user pointing their avatar at
 *     another's file — and it is traversal-aware, so `covers/../avatars/<me>`
 *     is refused rather than normalised into acceptance.
 *
 * `''` clears the column; an absent key leaves it alone.
 */
export function validateMediaPath(
  actor: SessionUser,
  kind: 'avatar' | 'cover',
  raw: string,
): { ok: true; value: string | null } | { ok: false; error: ProfileFieldError } {
  const value = raw.trim();
  if (value.length === 0) return { ok: true, value: null };

  const prefix = `${PUBLIC_PREFIX}/${KIND_DIRECTORY[kind]}/`;
  if (!value.startsWith(prefix) || !ownsUploadPath(actor, value)) {
    return {
      ok: false,
      error: {
        field: kind,
        message: 'That image could not be attached. Upload it again.',
      },
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// The whole form
// ---------------------------------------------------------------------------

/**
 * Validate every field, collecting all failures.
 *
 * The field order below is the form's order, so the error list a user reads
 * runs top to bottom rather than in whatever order the checks happen to be
 * written in.
 */
export function validateProfile(actor: SessionUser, input: ProfileInput): ProfileValidation {
  const errors: ProfileFieldError[] = [];

  const name = input.name ?? '';
  const handle = input.handle ?? '';
  const bio = input.bio ?? '';

  for (const error of [validateName(name), validateHandle(handle), validateBio(bio)]) {
    if (error) errors.push(error);
  }

  const socials = normalizeSocials({
    twitter: input.twitter,
    github: input.github,
    website: input.website,
  });
  if (!socials.ok) errors.push(...socials.errors);

  const media: { avatarPath?: string | null; coverPath?: string | null } = {};
  if (input.avatarPath !== undefined) {
    const result = validateMediaPath(actor, 'avatar', input.avatarPath);
    if (result.ok) media.avatarPath = result.value;
    else errors.push(result.error);
  }
  if (input.coverPath !== undefined) {
    const result = validateMediaPath(actor, 'cover', input.coverPath);
    if (result.ok) media.coverPath = result.value;
    else errors.push(result.error);
  }

  if (errors.length > 0) return { ok: false, errors };

  const trimmedBio = bio.trim();
  return {
    ok: true,
    value: {
      name: name.trim(),
      handle: normalizeHandle(handle),
      bio: trimmedBio.length === 0 ? null : trimmedBio,
      socials: socials.ok ? socials.value : {},
      ...media,
    },
  };
}

// ---------------------------------------------------------------------------
// The guarded write
// ---------------------------------------------------------------------------

export interface SaveProfileInput {
  /** The resolved session user, or `null` for an anonymous caller. */
  actor: SessionUser | null;
  /** The row the payload asks to write. Compared, never used to build a path. */
  targetUserId: string;
  input: ProfileInput;
  /** Injected so a test does not have to read a wall clock. */
  now?: Date;
}

export interface SaveProfileResult {
  state: ProfileFormState;
  /** The written row, present only when `state.status === 200`. */
  user?: UserRecord;
}

/**
 * Authorize, validate, then write — in that order, and with the write
 * unreachable unless the first two passed.
 *
 * The ordering is the security property, not a style choice. Validating first
 * would let an unauthorized caller use the error messages as an oracle — "that
 * handle is taken" is a probe — and would spend a database read on a request
 * that was never going to be allowed. `guardArticleMutation` in
 * `lib/auth/session.ts` makes the same argument for articles; the shape here
 * is its profile equivalent, with `requireProfileOwner`'s rule inlined so the
 * outcome is a form state rather than a thrown error the form cannot render.
 */
export async function saveProfile(input: SaveProfileInput): Promise<SaveProfileResult> {
  const { actor, targetUserId } = input;

  // 1. Authorization, before anything is read or parsed.
  if (!actor) {
    return { state: { ...EMPTY_PROFILE_FORM_STATE, status: 401, formError: new NotAuthenticatedError().message } };
  }
  if (!ownsProfile(actor, targetUserId)) {
    return {
      state: {
        ...EMPTY_PROFILE_FORM_STATE,
        status: 403,
        formError: new ForbiddenError('You can only edit your own profile.').message,
      },
    };
  }

  // 2. Shape.
  const parsed = validateProfile(actor, input.input);
  if (!parsed.ok) return { state: invalid(parsed.errors) };
  const value = parsed.value;

  // 3. Uniqueness, for the field-level message only — the unique index is what
  //    guarantees it, and the catch below closes the race between the two.
  const existing = await findUserByHandle(value.handle);
  if (existing && existing.id !== actor.id) {
    return { state: field('handle', 'That handle is taken. Choose another.') };
  }

  // 4. The write. `actor.id` — never `targetUserId`, even though the two are
  //    provably equal here. The guarantee should not depend on a check three
  //    lines up staying correct through a future edit.
  let user: UserRecord;
  try {
    user = await updateUser(actor.id, {
      name: value.name,
      handle: value.handle,
      bio: value.bio,
      socials: value.socials,
      ...(value.avatarPath !== undefined ? { avatarPath: value.avatarPath } : {}),
      ...(value.coverPath !== undefined ? { coverPath: value.coverPath } : {}),
    });
  } catch (error) {
    if (isHandleConflict(error)) {
      return { state: field('handle', 'That handle is taken. Choose another.') };
    }
    throw error;
  }

  return {
    state: {
      errors: [],
      formError: null,
      status: 200,
      savedAt: (input.now ?? new Date()).toISOString(),
      handle: user.handle,
    },
    user,
  };
}

/**
 * Does this error say the `handle` unique index rejected the write?
 *
 * Read structurally rather than by matching the message text: Prisma's strings
 * are not a stable interface, and a version bump that reworded them would turn
 * a handled race into a 500 shown to a user who did nothing wrong.
 */
function isHandleConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  if (typeof target === 'string') return target.includes('handle');
  return Array.isArray(target) && target.includes('handle');
}
