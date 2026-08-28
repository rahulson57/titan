/**
 * `/signin` (SPEC-005, "Routes & actions").
 *
 * ── Why this is a Server Component and `/signup` is not ────────────────────
 * The two forms are shaped differently, so they get different machinery.
 *
 * Sign-up has four fields that fail independently, each needing its own
 * message and its typed value preserved across a rejection — that is exactly
 * what `useActionState` is for, and it is why `/signup` is a client component.
 *
 * Sign-in has ONE outcome on failure, by design: SPEC-005 requires "a single
 * generic message" so wrong-password and unknown-email are indistinguishable.
 * There is no per-field state to carry, and no value worth preserving — a
 * browser will not refill a password field anyway, and echoing the email back
 * would write the user's address into browser history, the referrer of every
 * following request, and any access log. With nothing to preserve, a plain
 * server-rendered form is strictly simpler, and it has a property the client
 * version does not: **it works with JavaScript disabled**, which on the one
 * page that gates access to the whole account is worth having.
 *
 * ── And it is what makes sign-out testable ─────────────────────────────────
 * SPEC-011 owns the top nav and the user menu that will eventually host the
 * sign-out control, and that slice has not landed. Meanwhile SPEC-005's oracle
 * requires `tests/e2e/auth.spec.ts` to prove that signing out deletes the
 * Session row and that the stale cookie is then anonymous — which needs a real
 * control to click, in this slice, today.
 *
 * Rendering that control HERE is not a workaround, it is the better answer to
 * a question this page has to handle regardless: what should `/signin` do for
 * someone who is already signed in? Bouncing them silently to `/` (the first
 * thing middleware did) tells them nothing. Saying "you are signed in as X"
 * and offering the way out is the honest response, and it happens to be the
 * one that leaves the action reachable.
 *
 * ── Why the styles are inline ──────────────────────────────────────────────
 * SPEC-003 (TASK-002) owns `app/globals.css`, which is not in this task's file
 * scope, so no `.auth-*` rule can be added there. Every value below therefore
 * reads a SPEC-003 design token rather than hard-coding a colour or a spacing
 * step — the tokens are the contract, and honouring them from a `style` prop
 * honours it exactly as a stylesheet rule would.
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';

import { Button } from '../../../components/ui/Button';
import { NEXT_PARAM, safeNextPath } from '../../../lib/auth/config';
import { auth } from '../../../lib/auth/session';
import { signInErrorMessage } from '../../../lib/auth/validation';
import { signInFromForm, signOut } from '../actions';

const column: CSSProperties = {
  maxWidth: '26rem',
  margin: '0 auto',
  padding: 'var(--space-7) var(--space-5)',
  fontFamily: 'var(--font-ui)',
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  marginBottom: 'var(--space-5)',
};

const inputStyle: CSSProperties = {
  padding: 'var(--space-3)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 'var(--text-ui-size)',
};

const labelStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  fontWeight: 600,
  color: 'var(--fg)',
};

/**
 * `--fg` on `--bg-subtle`, not a red.
 *
 * SPEC-002's budget requires >= 4.5:1 body contrast in BOTH themes and
 * SPEC-003's token set has no error colour with a verified ratio; inventing one
 * here would put an unmeasured value on the page and risk the contrast gate.
 * `role="alert"` plus the border carries the emphasis, and colour was never the
 * accessible signal anyway.
 */
const errorStyle: CSSProperties = {
  color: 'var(--fg)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3)',
  marginBottom: 'var(--space-5)',
  fontSize: 'var(--text-meta-size)',
};

interface PageProps {
  /** Next 15 hands search params to a Server Component as a Promise. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const next = safeNextPath(first(params[NEXT_PARAM]) ?? null);
  const session = await auth();

  if (session) {
    return (
      <main style={column}>
        <h1 style={{ font: 'var(--text-h1)', marginBottom: 'var(--space-5)' }}>
          You are signed in
        </h1>
        <p style={{ marginBottom: 'var(--space-6)', color: 'var(--fg-muted)' }}>
          Signed in as <strong data-session-handle>@{session.user.handle}</strong>.
        </p>
        {/*
          A plain form posting straight to the Server Action — no client
          component, no handler. `signOut` deletes the Session row and clears
          the cookie, which is what makes the revocation real rather than a
          client-side pretence (DEC-005).
        */}
        <form action={signOut}>
          <Button type="submit" variant="secondary" style={{ width: '100%' }}>
            Sign out
          </Button>
        </form>
        <p style={{ marginTop: 'var(--space-5)', fontSize: 'var(--text-meta-size)' }}>
          <Link href="/">Back to reading</Link>
        </p>
      </main>
    );
  }

  const error = signInErrorMessage(first(params.error));

  return (
    <main style={column}>
      <h1 style={{ font: 'var(--text-h1)', marginBottom: 'var(--space-6)' }}>Sign in</h1>

      {/*
        `role="alert"` announces the failure as it renders — without it a
        screen-reader user is told nothing and simply waits. Rendered
        conditionally rather than as an always-present empty region, which
        several screen readers announce less reliably.

        `data-auth-error` is the hook `tests/e2e/auth.spec.ts` reads: the
        oracle needs exactly the message with no surrounding chrome, and
        matching on visible prose would make that assertion hostage to the
        page's wording.
      */}
      {error ? (
        <p role="alert" data-auth-error style={errorStyle}>
          {error}
        </p>
      ) : null}

      <form action={signInFromForm} noValidate>
        <input type="hidden" name={NEXT_PARAM} value={next} />

        <div style={fieldStyle}>
          <label htmlFor="email" style={labelStyle}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            style={inputStyle}
          />
        </div>

        <div style={fieldStyle}>
          <label htmlFor="password" style={labelStyle}>
            Password
          </label>
          {/*
            `current-password`, not `new-password`: it tells the password
            manager to offer the SAVED credential rather than propose a fresh
            one, which on a sign-in form is the difference between one click
            and a confusing generated string.
          */}
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            style={inputStyle}
          />
        </div>

        <Button type="submit" style={{ width: '100%' }}>
          Sign in
        </Button>
      </form>

      <p style={{ marginTop: 'var(--space-5)', fontSize: 'var(--text-meta-size)' }}>
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </main>
  );
}
