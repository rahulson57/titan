'use server';

/**
 * The profile Server Action (SPEC-010, `/settings/profile`).
 *
 * ── This file is a wrapper, and that is the security boundary ─────────────
 * It does three things: resolve the session from the cookie, read the strings
 * out of `FormData`, and hand both to `saveProfile`. Every rule — ownership,
 * validation, normalization, uniqueness — lives in `lib/profile/`, where
 * Vitest can reach it without a request scope. `app/editor/actions.ts` is
 * shaped the same way and says why at greater length.
 *
 * The part specific to THIS action is what must NOT be exported. Next publishes
 * a callable id for every export of a `'use server'` module, so an exported
 * function taking the caller's identity as a parameter is a function an
 * attacker can call while supplying both sides of the ownership check.
 * `saveProfile(actor, …)` is exactly that shape, which is why it lives in
 * `lib/profile/validation.ts` and why the only thing exported here resolves the
 * session itself, from `auth()`, and never accepts one.
 *
 * ── Why `userId` is read out of the form at all ───────────────────────────
 * SPEC-010's oracle requires "a payload targeting user B's id returns HTTP 403
 * and leaves both rows unchanged". A form that could only ever address the
 * session user makes that criterion true and unobservable: there would be no
 * payload to write the test against. The field is therefore accepted, compared
 * once inside `saveProfile`, and never used to build anything — the accepted
 * path writes `actor.id`. DEC-034 approved this exact shape for
 * `/api/upload`'s `userId`, for this exact reason. Do not "simplify" it away,
 * and do not let it influence the row that is written.
 *
 * ── Only async functions may be exported ──────────────────────────────────
 * Next treats a plain `export const` in a `'use server'` module as a build
 * error that fails the whole route, not a lint warning. `ProfileFormState`,
 * `EMPTY_PROFILE_FORM_STATE` and every message therefore live in
 * `lib/profile/validation.ts` and are imported by both this file and the form.
 */

import { revalidatePath } from 'next/cache';

import { auth } from '../../../lib/auth/session';
import {
  saveProfile,
  type ProfileFormState,
  type ProfileInput,
} from '../../../lib/profile/validation';
import { SETTINGS_PROFILE, profileHref } from '../../../lib/routes';

/** A required text field: absent reads as empty, which validation rejects. */
function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * An optional media field.
 *
 * The distinction this preserves is the one that matters: `undefined` means
 * "not submitted, leave the column alone", `''` means "clear it". Collapsing
 * them would make every text-only save wipe the user's avatar — which is the
 * kind of defect that is invisible in review and obvious to the one person it
 * happens to.
 */
function optionalText(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Save the signed-in user's profile.
 *
 * Shaped for `useActionState`: it takes the previous state and returns the
 * next one rather than throwing or redirecting, because a rejected save has to
 * put field-level errors next to the inputs that caused them while keeping
 * what the user typed. A `redirect()` here would blank the form on every
 * validation failure, and there are four sealed criteria about failures.
 *
 * `revalidatePath` runs only on the accepted path, and covers both surfaces a
 * successful save changes: the settings form itself, and the public profile.
 * The OLD handle is revalidated as well as the new one — a handle change moves
 * the URL and SPEC-010 says it "does not leave a redirect", so the previous
 * path must stop serving the cached page rather than keep answering under a
 * name that is now free for someone else to take.
 */
export async function updateProfile(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const session = await auth();
  const actor = session?.user ?? null;

  const input: ProfileInput = {
    name: text(formData, 'name'),
    handle: text(formData, 'handle'),
    bio: text(formData, 'bio'),
    twitter: text(formData, 'twitter'),
    github: text(formData, 'github'),
    website: text(formData, 'website'),
    avatarPath: optionalText(formData, 'avatarPath'),
    coverPath: optionalText(formData, 'coverPath'),
  };

  // The row the payload asks to write. Defaults to the caller's own id so an
  // honest form need not send it; a form that DOES send someone else's is the
  // case the 403 exists for.
  const requested = formData.get('userId');
  const targetUserId =
    typeof requested === 'string' && requested.length > 0 ? requested : (actor?.id ?? '');

  const result = await saveProfile({ actor, targetUserId, input });

  if (result.state.status === 200 && result.user) {
    const previousHandle = actor?.handle;
    revalidatePath(SETTINGS_PROFILE);
    revalidatePath(profileHref(result.user.handle));
    if (previousHandle && previousHandle !== result.user.handle) {
      revalidatePath(profileHref(previousHandle));
    }
  }

  return result.state;
}
