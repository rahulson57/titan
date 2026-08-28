/**
 * 404 — the `*` row of SPEC-011's route table (App Shell, public).
 *
 * > "`app/not-found.tsx` — 404 with a link home and a search box."
 *
 * This file is what makes the route map *closed*. Every path the table does
 * not name lands here, and Next serves it with a real HTTP 404 status rather
 * than a 200 carrying an apology — which matters beyond tidiness: a soft 404
 * gets indexed, gets cached, and tells a crawler the page exists.
 *
 * The search box is not decoration. A reader who reached a 404 usually
 * mistyped or followed a stale link, and the useful response is a way to find
 * what they wanted, not just a way back to the top. It is the same `NavSearch`
 * the chrome uses, so there is one search entry in the product rather than two
 * that can drift.
 *
 * ── Why this is a Server Component with no client JavaScript ──────────────
 * Nothing here has state. `EmptyState` and `NavSearch` are both server-
 * renderable, and `NavSearch` is a plain GET form, so the whole page works
 * before hydration and without JavaScript — which is the right posture for the
 * page a reader hits when something has already gone wrong.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the wrapper reads design tokens through a `style` prop. The
 * visual content itself is the design system's `EmptyState` primitive, which
 * is where the visual contract lives.
 */

import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { NavSearch } from '../components/nav/NavSearch';
import { EmptyState } from '../components/ui/EmptyState';
import { HOME } from '../lib/routes';

export const metadata: Metadata = {
  title: 'Page not found',
};

const columnStyle: CSSProperties = {
  maxWidth: 'var(--measure)',
  margin: '0 auto',
  padding: 'var(--space-8) var(--space-5)',
  fontFamily: 'var(--font-ui)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--space-6)',
};

export default function NotFound() {
  return (
    <main style={columnStyle} data-testid="not-found">
      {/*
        A real `h1` for the document outline, hidden visually because
        `EmptyState`'s own heading already says the same thing on screen and
        two stacked headings would read as a design mistake. Without it this
        page has no level-one heading at all, which is what a screen-reader
        user lands on first. `.visually-hidden` is SPEC-003's utility.
      */}
      <h1 className="visually-hidden">Page not found</h1>

      <EmptyState
        title="We couldn't find that page"
        description="The link may be broken, or the story may have been unpublished."
        action={
          // The criterion is "renders app/not-found.tsx with a link to `/`".
          // A plain anchor, not a router push: this page must work with no
          // JavaScript at all.
          <a href={HOME} data-testid="not-found-home">
            Back to reading
          </a>
        }
      />

      <NavSearch />
    </main>
  );
}
