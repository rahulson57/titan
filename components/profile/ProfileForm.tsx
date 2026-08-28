'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The `/settings/profile` form (SPEC-010, DEC-051).
 *
 * ── Why this is a separate file from the page ─────────────────────────────
 * `'use client'` is per-module, and this form needs `useActionState` to put
 * field-level errors next to the inputs that caused them. The page cannot be
 * the client module, because it also has to resolve the session against the
 * database — `middleware.ts` runs on the Edge runtime and can only see that a
 * `titan.session` cookie is PRESENT, so a forged cookie reaches the page and
 * only `auth()` catches it. `app/bookmarks/page.tsx` states the rule: the
 * middleware is a redirector, the page is the boundary. Collapsing this route
 * onto the redirector to save a file would make identity editing the one
 * exception to it.
 *
 * So: server page resolves auth and loads the row, this renders and submits.
 * The same seam as `app/editor/[id]/page.tsx` → `components/editor/Editor.tsx`.
 *
 * ── Why every input is controlled ─────────────────────────────────────────
 * React 19 resets an uncontrolled form after a `<form action>` submission
 * completes. On the accepted path that is harmless; on a REJECTED one it would
 * blank every field the person just filled in, so fixing a bad handle would
 * mean retyping a 220-character bio. Holding the values in state means a
 * rejection changes only what is displayed beside the fields.
 *
 * The alternative — echoing the submitted values back inside the action's
 * return value — also works and was rejected: it puts the user's bio on a
 * round trip it does not need to make, and it makes the state shape (which
 * `lib/profile/validation.ts` owns, and which the unit suite asserts against)
 * carry presentation data.
 *
 * ── What this file does NOT decide ────────────────────────────────────────
 * Nothing. Every rule — ownership, length bounds, handle shape, social
 * normalization, media-path checks — is `lib/profile/validation.ts`'s, and
 * SPEC-010's four "rejected with a field-level error and no write" criteria
 * are asserted there, against a real database, in `profile-validation.test.ts`.
 * This form is the surface that consumes those rules; it is deliberately not
 * the thing they are tested through, and it must not grow a check of its own —
 * a second copy of a bound is a second bound to keep in agreement, and the
 * client copy is the one an attacker skips.
 *
 * `noValidate` is set for the same reason: browser-native validation would
 * reject some inputs before the server ever saw them, which sounds helpful and
 * means the server-side rule stops being exercised by the ordinary path.
 */

import { useActionState, useState, type CSSProperties } from 'react';

import { AvatarUploader } from './AvatarUploader';
import { CoverUploader } from './CoverUploader';
import { updateProfile } from '../../app/settings/profile/actions';
import type { ProfileField, ProfileFormState } from '../../lib/profile/validation';
import type { StoredSocials } from '../../lib/profile/socials';
import { profileHref } from '../../lib/routes';

export interface ProfileFormUser {
  id: string;
  name: string;
  handle: string;
  bio: string | null;
  avatarPath: string | null;
  coverPath: string | null;
  socials: StoredSocials;
}

export interface ProfileFormProps {
  user: ProfileFormUser;
  /**
   * `EMPTY_PROFILE_FORM_STATE`, and the field bounds, handed down by the page.
   *
   * ── Why these are props and not imports ─────────────────────────────────
   * Every import of a `'use client'` module is bundled FOR THE CLIENT.
   * `lib/profile/validation.ts` reaches `lib/db/users.ts` (Prisma) and
   * `lib/media/store.ts` (which imports `node:crypto`), so importing it here
   * for two numbers and a constant breaks the build outright —
   * `UnhandledSchemeError: Reading from "node:crypto" is not handled`, and the
   * route 500s. Measured, not guessed: it is what this file did in its first
   * draft, and the smoke test on a running server is what caught it.
   *
   * The alternatives were worse. Re-declaring `220` and `60` here would put a
   * bound in two files, and the copy that drifts is always the one the server
   * does not enforce. Splitting the pure rules into a third `lib/profile/`
   * module would mean inventing a filename outside the scope this task was
   * granted. Passing them from the server — which CAN import the module that
   * owns them — keeps exactly one source of truth and adds no file.
   *
   * `import type` above is erased at compile time and adds no runtime edge,
   * which is why the types can still come straight from the owning module.
   */
  initialState: ProfileFormState;
  limits: { nameMax: number; bioMax: number };
}

const formStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  marginBlockEnd: 'var(--space-5)',
};

const labelStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg-muted)',
};

const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 'var(--text-ui-size)',
  color: 'var(--fg)',
  backgroundColor: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-3)',
};

const hintStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--fg-muted)',
};

const errorTextStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  color: 'var(--accent)',
};

const sectionStyle: CSSProperties = {
  borderBlockStart: '1px solid var(--border)',
  paddingBlockStart: 'var(--space-5)',
  marginBlockStart: 'var(--space-5)',
};

export function ProfileForm({ user, initialState, limits }: ProfileFormProps) {
  const [state, formAction, pending] = useActionState(updateProfile, initialState);

  // Controlled, so a rejected submit keeps what was typed. See the header.
  const [name, setName] = useState(user.name);
  const [handle, setHandle] = useState(user.handle);
  const [bio, setBio] = useState(user.bio ?? '');
  const [twitter, setTwitter] = useState(user.socials.twitter ?? '');
  const [github, setGithub] = useState(user.socials.github ?? '');
  const [website, setWebsite] = useState(user.socials.website ?? '');

  const errorFor = (field: ProfileField): string | null =>
    state.errors.find((error) => error.field === field)?.message ?? null;

  /**
   * One field, with its error wired up.
   *
   * `aria-describedby` is set ONLY when there is something to point at.
   * Referencing an id that does not exist is not harmless: several screen
   * readers announce nothing at all for the field rather than falling back to
   * its label.
   */
  const field = (
    id: ProfileField,
    label: string,
    value: string,
    onChange: (next: string) => void,
    options: {
      hint?: string;
      multiline?: boolean;
      maxLength?: number;
      autoComplete?: string;
      placeholder?: string;
    } = {},
  ) => {
    const error = errorFor(id);
    const errorId = `${id}-error`;
    const hintId = `${id}-hint`;
    const describedBy = [error ? errorId : null, options.hint ? hintId : null]
      .filter(Boolean)
      .join(' ');

    const shared = {
      id,
      name: id,
      value,
      style: inputStyle,
      'aria-invalid': error ? (true as const) : undefined,
      'aria-describedby': describedBy || undefined,
      maxLength: options.maxLength,
      autoComplete: options.autoComplete,
      placeholder: options.placeholder,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    };

    return (
      <div style={fieldStyle}>
        <label htmlFor={id} style={labelStyle}>
          {label}
        </label>
        {options.multiline ? (
          <textarea {...shared} rows={4} style={{ ...inputStyle, resize: 'vertical' }} />
        ) : (
          <input {...shared} type="text" />
        )}
        {options.hint ? (
          <span id={hintId} style={hintStyle}>
            {options.hint}
          </span>
        ) : null}
        {error ? (
          <span id={errorId} role="alert" data-field-error={id} style={errorTextStyle}>
            {error}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <form
      action={formAction}
      noValidate
      style={formStyle}
      data-testid="profile-form"
      // The action's HTTP semantics, exposed so a test can observe the
      // difference between an accepted and a rejected save. A Server Action's
      // transport is always 200, so without this the status would exist only
      // inside the return value and nowhere a browser could see it.
      data-status={String(state.status)}
      // Present ONLY when an action has RETURNED a successful save, so it
      // cannot be true while a request is in flight and a rejection leaves it
      // absent. This is what e2e waits on instead of polling the row from a
      // second process — the precondition race that cost a gate run on
      // TASK-006. Never seed it from the server row.
      data-saved-at={state.savedAt ?? undefined}
    >
      {/*
        The row this payload asks to write. It is compared once, server-side,
        and never used to build anything — the accepted path writes
        `actor.id`. Without it, SPEC-010's "a payload targeting user B's id
        returns 403" would be true and unobservable, because no test could
        express the payload. DEC-034 approved the identical shape for
        /api/upload's `userId`.
      */}
      <input type="hidden" name="userId" value={user.id} />

      {state.formError ? (
        <p role="alert" data-testid="profile-form-error" style={errorTextStyle}>
          {state.formError}
        </p>
      ) : null}

      {field('name', 'Name', name, setName, { maxLength: limits.nameMax, autoComplete: 'name' })}

      {field('handle', 'Handle', handle, setHandle, {
        maxLength: 24,
        autoComplete: 'username',
        hint: `Your profile lives at ${profileHref(handle || 'handle')}. Changing it moves the URL and leaves no redirect.`,
      })}

      {field('bio', 'Bio', bio, setBio, {
        multiline: true,
        // No `maxLength` on the input, deliberately. A hard cap in the browser
        // would silently truncate at 220 and the server-side rejection — which
        // is what SPEC-010's criterion names, and what the unit suite asserts —
        // would never be reachable through the real form.
        hint: `${[...bio].length} of ${limits.bioMax} characters. Plain text; markup is shown as typed.`,
      })}

      <div style={sectionStyle}>
        <AvatarUploader initialPath={user.avatarPath} name={user.name} />
        {errorFor('avatar') ? (
          <span role="alert" data-field-error="avatar" style={errorTextStyle}>
            {errorFor('avatar')}
          </span>
        ) : null}

        <CoverUploader initialPath={user.coverPath} name={user.name} />
        {errorFor('cover') ? (
          <span role="alert" data-field-error="cover" style={errorTextStyle}>
            {errorFor('cover')}
          </span>
        ) : null}
      </div>

      <div style={sectionStyle}>
        {field('twitter', 'X profile', twitter, setTwitter, {
          hint: 'A handle like @name, or the full link to your profile.',
          placeholder: '@name',
        })}
        {field('github', 'GitHub profile', github, setGithub, {
          hint: 'A username, or the full link to your profile.',
          placeholder: 'name',
        })}
        {field('website', 'Website', website, setWebsite, {
          hint: 'A full web address, starting with https://',
          placeholder: 'https://example.com',
        })}
      </div>

      <button
        type="submit"
        className="btn btn--primary"
        disabled={pending}
        data-testid="profile-save"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>

      {state.status === 200 && state.savedAt ? (
        // `role="status"` rather than `role="alert"`: a successful save is not
        // an interruption, and alert would talk over whatever the person is
        // doing next.
        <span role="status" style={hintStyle} data-testid="profile-saved">
          {' '}
          Saved.
        </span>
      ) : null}
    </form>
  );
}
