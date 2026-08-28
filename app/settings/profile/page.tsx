/**
 * `/settings/profile` — the owner-only profile editor (SPEC-010).
 *
 * ── Two gates on "signed in", and neither is redundant ────────────────────
 * `middleware.ts` already bounces a request with no `titan.session` cookie to
 * `/signin?next=/settings/profile` — `/settings` is one of its protected
 * prefixes, and that is what satisfies SPEC-010's redirect criterion for an
 * anonymous visitor. This page checks again, because the two layers answer
 * different questions:
 *
 *   - The middleware runs on the Edge runtime, which has no Prisma and no
 *     SQLite, so it can only ask *"is a cookie present?"*. A forged or expired
 *     `titan.session` sails straight through it.
 *   - This page runs on the server with the database, so `auth()` asks the
 *     question that matters: *"does this cookie name a live session?"*
 *
 * Without the second check, a hand-written cookie would be a login for the one
 * route that edits identity. `app/bookmarks/page.tsx` states the same rule for
 * a page where the stakes are lower.
 *
 * The redirect target is built by `signInHref`, so it is spelled the way the
 * middleware spells it and `safeNextPath` re-validates it on the way back out
 * — one `?next=` contract, several call sites, no second encoding rule.
 *
 * ── Why the form is a separate module (DEC-051) ───────────────────────────
 * The form needs `useActionState` to keep field-level errors beside the inputs
 * that caused them, and `'use client'` is per-module — so a page that is also
 * the form could not call `auth()`, and the paragraph above would stop being
 * true. `components/profile/ProfileForm.tsx` is the client half. This is the
 * seam `app/editor/[id]/page.tsx` → `components/editor/Editor.tsx` already
 * uses.
 *
 * ── Why the row is loaded here and not in the form ────────────────────────
 * A client component cannot query. Handing it the row also means the form is a
 * pure function of its props, which is what lets it be reasoned about without
 * a database — and it makes the "prefilled from the row" property something a
 * test can assert rather than something the form fetches for itself.
 */

import { redirect } from 'next/navigation';
import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { ProfileForm } from '../../../components/profile/ProfileForm';
import { auth } from '../../../lib/auth/session';
import { findUserById } from '../../../lib/db/users';
import { BIO_MAX, EMPTY_PROFILE_FORM_STATE, NAME_MAX } from '../../../lib/profile/validation';
import { SETTINGS_PROFILE, profileHref, signInHref } from '../../../lib/routes';

/** Reads the session and the user's own row. Never statically rendered. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Profile settings — titan',
  // Nothing here should ever be indexed: it is one person's settings page, and
  // it is behind a session in any case.
  robots: { index: false, follow: false },
};

const columnStyle: CSSProperties = {
  maxWidth: '40rem',
  margin: '0 auto',
  padding: 'var(--space-7) var(--space-5)',
  fontFamily: 'var(--font-ui)',
};

const headingStyle: CSSProperties = {
  fontSize: '32px',
  lineHeight: 'var(--text-h1-leading)',
  fontWeight: 'var(--text-h1-weight)' as CSSProperties['fontWeight'],
  fontFamily: 'var(--font-reading)',
  color: 'var(--fg)',
  margin: '0 0 var(--space-2)',
};

const subheadStyle: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
  margin: '0 0 var(--space-7)',
};

export default async function ProfileSettingsPage() {
  const session = await auth();
  if (!session) redirect(signInHref(SETTINGS_PROFILE));

  // Re-read the row rather than rendering from the session. `SessionUser` is
  // deliberately narrow — id, handle, name, avatarPath — precisely so a
  // careless prop cannot serialise a password hash into a page, and the form
  // needs the bio, cover and socials that projection leaves out.
  const user = await findUserById(session.user.id);
  // A live session whose user row is gone is not a state a signed-in person
  // can be left in: sign-out is what revokes, so this means the row was
  // deleted underneath them. Send them to sign in rather than 500.
  if (!user) redirect(signInHref(SETTINGS_PROFILE));

  return (
    <main style={columnStyle} data-testid="profile-settings-page">
      <h1 style={headingStyle}>Profile</h1>
      <p style={subheadStyle}>
        This is what readers see at{' '}
        <a href={profileHref(user.handle)} data-testid="profile-settings-public-link">
          {profileHref(user.handle)}
        </a>
        .
      </p>

      {/*
        `initialState` and `limits` are handed down rather than imported by the
        form, and that is not decoration: every import of a `'use client'`
        module is bundled for the browser, and `lib/profile/validation.ts`
        reaches Prisma and `node:crypto` through the modules that own the
        bounds. Importing it there breaks the build outright (measured:
        `UnhandledSchemeError: Reading from "node:crypto"`, route 500). This
        page can import it, so the numbers still have exactly one home.
      */}
      <ProfileForm
        user={{
          id: user.id,
          name: user.name,
          handle: user.handle,
          bio: user.bio,
          avatarPath: user.avatarPath,
          coverPath: user.coverPath,
          socials: user.socials,
        }}
        initialState={EMPTY_PROFILE_FORM_STATE}
        limits={{ nameMax: NAME_MAX, bioMax: BIO_MAX }}
      />
    </main>
  );
}
