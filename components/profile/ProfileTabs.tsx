/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every component file here
   carries them. They pin esbuild's JSX runtime for the Vitest transform and
   leave Next's own build untouched. */

/**
 * The three profile tabs (SPEC-010).
 *
 * > **Published** (default, public) · **Drafts** (owner only, hidden entirely
 * > from other viewers) · **Bookmarks** (owner only)
 *
 * ── "Hidden entirely", and what this component can and cannot promise ─────
 * The owner-only tabs are not rendered for anyone else — not disabled, not
 * `display: none`, not present-and-unstyled. SPEC-010's oracle says "absent
 * from the DOM", and it is right to: a tab hidden with CSS is still in the
 * page source, still in the accessibility tree of anything that ignores the
 * style, and still tells a stranger that the author has drafts.
 *
 * But absence from the DOM is a *disclosure* control, never an authorization
 * one. Anyone can type `?tab=drafts`. The rule that actually protects the
 * rows is in `app/[handle]/page.tsx`, which resolves the tab against the
 * viewer before it queries anything, so a non-owner asking for drafts is
 * served the published list rather than a hidden one. This component being
 * the only guard would be the classic version of this bug — and it is why
 * `visibleTabs` is exported and unit-testable rather than being an inline
 * `.filter()` in the JSX.
 *
 * ── Why the tabs are links and not buttons ────────────────────────────────
 * `?tab=` is the state, so the URL is shareable, the back button works, and a
 * reader with JavaScript disabled can still reach every tab. `aria-current`
 * marks the active one, which is what a screen reader announces; colour alone
 * would not.
 */

import type { CSSProperties } from 'react';

import { profileHref } from '../../lib/routes';

/** SPEC-010's three tabs, in the order the spec lists them. */
export const PROFILE_TABS = ['published', 'drafts', 'bookmarks'] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number];

/** SPEC-010: "Published (default, public)". */
export const DEFAULT_PROFILE_TAB: ProfileTab = 'published';

/** The two SPEC-010 restricts to the profile's owner. */
const OWNER_ONLY: ReadonlySet<ProfileTab> = new Set<ProfileTab>(['drafts', 'bookmarks']);

const LABELS: Record<ProfileTab, string> = {
  published: 'Published',
  drafts: 'Drafts',
  bookmarks: 'Bookmarks',
};

/**
 * Which tabs this viewer may see, in spec order.
 *
 * Exported so the rule is a function a unit test can enumerate rather than a
 * filter buried in JSX — and so the page and the nav cannot disagree about it.
 */
export function visibleTabs(isOwner: boolean): ProfileTab[] {
  return PROFILE_TABS.filter((tab) => isOwner || !OWNER_ONLY.has(tab));
}

/**
 * Read `?tab=` for a given viewer, falling back to the public default.
 *
 * The `isOwner` parameter is the load-bearing half: a stranger asking for
 * `?tab=drafts` gets `published`, so the page never even builds a draft query
 * for them. Falling back rather than 404ing is deliberate — an unknown or
 * forbidden tab is a bad link, and landing a reader on the profile they asked
 * for is a better answer than an error page. It also keeps the two cases
 * indistinguishable from outside, so the parameter cannot be used to probe
 * whether an author has drafts.
 */
export function parseProfileTab(value: string | null | undefined, isOwner: boolean): ProfileTab {
  const allowed = visibleTabs(isOwner);
  return allowed.includes(value as ProfileTab) ? (value as ProfileTab) : DEFAULT_PROFILE_TAB;
}

/** `/@handle` for the default tab, `/@handle?tab=x` for the others. */
export function profileTabHref(handle: string, tab: ProfileTab): string {
  const base = profileHref(handle);
  return tab === DEFAULT_PROFILE_TAB ? base : `${base}?tab=${tab}`;
}

export interface ProfileTabsProps {
  handle: string;
  active: ProfileTab;
  isOwner: boolean;
}

const navStyle: CSSProperties = {
  borderBlockEnd: '1px solid var(--border)',
  marginBlockStart: 'var(--space-7)',
  fontFamily: 'var(--font-ui)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: '0 var(--space-5)',
  display: 'flex',
  gap: 'var(--space-6)',
};

function tabStyle(isActive: boolean): CSSProperties {
  return {
    display: 'inline-block',
    padding: 'var(--space-3) 0',
    fontSize: 'var(--text-meta-size)',
    textDecoration: 'none',
    color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
    // The underline is on the link rather than a separate bar so it moves with
    // the text at any font size, and so it survives a forced-colours mode that
    // drops backgrounds.
    borderBlockEnd: `2px solid ${isActive ? 'var(--fg)' : 'transparent'}`,
    marginBlockEnd: '-1px',
  };
}

export function ProfileTabs({ handle, active, isOwner }: ProfileTabsProps) {
  const tabs = visibleTabs(isOwner);

  return (
    <nav style={navStyle} aria-label="Profile sections" data-testid="profile-tabs">
      <ul style={listStyle}>
        {tabs.map((tab) => (
          <li key={tab}>
            <a
              href={profileTabHref(handle, tab)}
              style={tabStyle(tab === active)}
              aria-current={tab === active ? 'page' : undefined}
              data-testid={`profile-tab-${tab}`}
            >
              {LABELS[tab]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
