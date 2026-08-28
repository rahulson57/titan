/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them. */
import type { CSSProperties } from 'react';

import { HOME } from '../../lib/routes';
import { FEED_TABS, type FeedTab } from '../../lib/feed/queries';

/**
 * The home feed's two tabs (SPEC-008).
 *
 * > Two tabs: **For you** (default, anonymous-safe) and **Following**
 * > (signed-in only)
 *
 * ── Links, not ARIA tabs, and this is a correctness decision ──────────────
 * The WAI-ARIA tab pattern (`role="tablist"` / `role="tab"` /
 * `aria-selected`) comes with a keyboard contract: arrow keys move between
 * tabs, Home/End jump to the ends, and only the selected tab is in the tab
 * order. Claiming the role without implementing the contract is worse than not
 * claiming it — a screen-reader user is told "tab, 1 of 2" and then finds that
 * the arrow keys do nothing. Implementing it needs a client component and
 * JavaScript on the highest-traffic route in the app.
 *
 * These are navigations, not in-page view switches: each tab is a different
 * URL that must be shareable and back-buttonable. So they are what they are —
 * links in a labelled `<nav>`, with `aria-current="page"` on the active one,
 * which is the mechanism a screen reader already announces. Zero client
 * JavaScript, correct semantics, and the URL stays the state.
 *
 * ── Why "Following" renders for signed-out readers too ────────────────────
 * "Signed-in only" describes the CONTENT, and the content is enforced in
 * `getFollowingPage`, which returns an empty page for an anonymous viewer
 * without touching the database. Hiding the tab entirely would make the
 * feature invisible to exactly the people who have not signed up yet, and it
 * would mean a shared `/?tab=following` link renders a page with no way back
 * to the tab the reader is looking at. The tab is visible; the tab's content
 * is the empty state, which invites them in.
 */

export interface FeedTabsProps {
  /** Which tab the page is rendering. */
  active: FeedTab;
  className?: string;
}

/** Label per tab id. A record, so adding a tab id is a compile error here. */
const TAB_LABELS: Record<FeedTab, string> = {
  'for-you': 'For you',
  following: 'Following',
};

/** `/` for the default tab; `?tab=` for the rest — the default has no marker. */
export function tabHref(tab: FeedTab): string {
  return tab === 'for-you' ? HOME : `${HOME}?tab=${tab}`;
}

const navStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-5)',
  alignItems: 'center',
  borderBlockEnd: '1px solid var(--border)',
  marginBlockEnd: 'var(--space-7)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-ui-size)',
};

function linkStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-block',
    padding: 'var(--space-3) 0',
    // The 2px underline is the active marker. It sits on the link rather than
    // on a pseudo-element so it is visible in forced-colors mode, where
    // decorative borders are dropped.
    borderBlockEnd: `2px solid ${active ? 'var(--fg)' : 'transparent'}`,
    marginBlockEnd: '-1px',
    color: active ? 'var(--fg)' : 'var(--fg-muted)',
    textDecoration: 'none',
  };
}

export function FeedTabs({ active, className }: FeedTabsProps) {
  return (
    <nav className={className} style={navStyle} aria-label="Feed" data-testid="feed-tabs">
      {FEED_TABS.map((tab) => (
        <a
          key={tab}
          href={tabHref(tab)}
          style={linkStyle(tab === active)}
          // The one thing that tells a screen-reader user which tab they are
          // on. Colour and the underline say it visually; this says it at all.
          aria-current={tab === active ? 'page' : undefined}
          data-testid={`feed-tab-${tab}`}
        >
          {TAB_LABELS[tab]}
        </a>
      ))}
    </nav>
  );
}

export default FeedTabs;
