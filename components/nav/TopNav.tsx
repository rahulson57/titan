/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx. */
import type { CSSProperties } from 'react';

import { NavSearch } from './NavSearch';
import { UserMenu } from './UserMenu';
import { Wordmark } from './Wordmark';
import { ThemeToggle } from '../ui/ThemeToggle';
import { auth } from '../../lib/auth/session';
import { BOOKMARKS, NEW_STORY, SIGN_IN, SIGN_UP } from '../../lib/routes';
import { signOut } from '../../app/(auth)/actions';
import { buttonClassName } from '../ui/Button';

/**
 * The persistent top navigation (SPEC-011).
 *
 * | State     | Left            | Right                                                             |
 * |-----------|-----------------|-------------------------------------------------------------------|
 * | Anonymous | wordmark → `/`  | Search · `Sign in` · `Get started` (primary)                        |
 * | Signed in | wordmark → `/`  | Search · `Write` · Bookmarks · ThemeToggle · avatar menu            |
 *
 * ── Why this is an async Server Component ─────────────────────────────────
 * It reads the session, and the session lives in the database behind a
 * httpOnly cookie. Resolving it on the server means the correct nav is in the
 * first HTML frame: a client-side check would render the anonymous nav, hydrate,
 * and then swap in `Write`/avatar — a visible flash of "signed out" on every
 * navigation for every signed-in reader.
 *
 * The cost is honest and worth stating: calling `auth()` here opts every route
 * that renders the nav into dynamic rendering, because `cookies()` is a
 * dynamic API. For this product that is not a loss — SPEC-004 puts the data in
 * a local SQLite file, `lib/auth/session.ts` resolves a session in one indexed
 * primary-key SELECT, and DEC-005 already accepted that cost per request in
 * writing as the price of revocable sessions.
 *
 * ── The ThemeToggle is rendered for anonymous visitors too ────────────────
 * SPEC-011's table lists ThemeToggle only on the signed-in row. It is rendered
 * in BOTH states here, deliberately, and this is the reasoning rather than an
 * oversight:
 *
 *   - SPEC-003's theming criteria are asserted by `tests/e2e/theme.spec.ts`,
 *     which drives `/` in a **fresh anonymous context** and looks for
 *     `[data-testid="theme-toggle"]`. That suite is currently skipped with the
 *     reason *"needs TASK-008 (App Shell) — SPEC-011 mounts ThemeToggle in the
 *     top nav; no page renders one yet"* — it names this task as its unblocker
 *     and never signs in. Under a signed-in-only reading it stays skipped
 *     forever and SPEC-003's toggle criteria are never actually verified.
 *   - Reading is the anonymous path on this product. A dark-mode switch that
 *     requires an account is a worse product and is not something any spec
 *     asks for.
 *
 * The criterion this task is measured against is *"the top nav renders
 * `Sign in` and `Get started` for an anonymous visitor and `Write`, Bookmarks,
 * ThemeToggle and the avatar menu for a signed-in user"* — it fixes what must
 * be present in each state, not what must be absent. Rendering the toggle in
 * both satisfies it and unblocks TASK-002's armed suite; withholding it
 * satisfies nothing extra. Flagged to the coordinator rather than done
 * quietly.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` is SPEC-003's file (TASK-002) and outside this task's file
 * scope, so the layout reads design tokens through `style` props. Every value
 * is a token; the shared button/avatar/toggle classes still come from the
 * design system's own primitives, which is where the visual contract lives.
 */

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-4)',
  blockSize: '57px', // the chrome is deliberately shallow; the article is the page
  paddingInline: 'var(--space-5)',
  borderBlockEnd: '1px solid var(--border)',
  background: 'var(--bg)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-ui-size)',
};

const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
};

const linkStyle: CSSProperties = {
  color: 'var(--fg)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

const mutedLinkStyle: CSSProperties = {
  ...linkStyle,
  color: 'var(--fg-muted)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

export interface TopNavProps {
  /** Echoed into the search box on `/search?q=`, so the chrome shows the query. */
  searchQuery?: string;
}

export async function TopNav({ searchQuery }: TopNavProps = {}) {
  const session = await auth();
  const user = session?.user ?? null;

  return (
    // `<header>` + `<nav>` rather than two divs: they are the landmarks a
    // screen-reader user navigates by, and `@axe-core/playwright` (SPEC-002's
    // a11y gate) checks the page has them.
    <header style={barStyle} data-testid="top-nav">
      <Wordmark />

      <nav style={actionsStyle} aria-label="Main">
        <NavSearch defaultQuery={searchQuery} />

        {user ? (
          <>
            <a style={mutedLinkStyle} href={NEW_STORY} data-testid="nav-write">
              {/* Original mark, drawn inline. SPEC-003 forbids a third-party
                  icon asset and `originality.test.ts` enforces it; two paths
                  do not justify a dependency. */}
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 17h4l9.2-9.2a1.6 1.6 0 0 0 0-2.3l-1.7-1.7a1.6 1.6 0 0 0-2.3 0L3 13v4z" />
              </svg>
              Write
            </a>

            <a
              style={mutedLinkStyle}
              href={BOOKMARKS}
              // Icon-only, so the accessible name is carried by aria-label.
              aria-label="Bookmarks"
              data-testid="nav-bookmarks"
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 3.5h10v13l-5-3.6-5 3.6v-13z" />
              </svg>
            </a>

            <ThemeToggle />

            <UserMenu
              user={{ handle: user.handle, name: user.name, avatarPath: user.avatarPath }}
              signOutAction={signOut}
            />
          </>
        ) : (
          <>
            <ThemeToggle />

            <a style={linkStyle} href={SIGN_IN} data-testid="nav-signin">
              Sign in
            </a>

            {/*
              "Get started" is the single primary action in the anonymous
              chrome (SPEC-011 marks it primary). It composes the design
              system's own button class rather than restyling an anchor, so the
              accent colour, radius and focus ring all stay SPEC-003's.
            */}
            <a
              className={buttonClassName({ variant: 'primary', size: 'sm' })}
              href={SIGN_UP}
              data-testid="nav-signup"
            >
              Get started
            </a>
          </>
        )}
      </nav>
    </header>
  );
}

export default TopNav;
