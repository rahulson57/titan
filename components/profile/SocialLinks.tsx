/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every component file here
   carries them. They pin esbuild's JSX runtime for the Vitest transform and
   leave Next's own build untouched. */

/**
 * The outbound links on a public profile (SPEC-010, "Social links").
 *
 * > Every outbound social link renders with `rel="nofollow noopener noreferrer"`
 * > and `target="_blank"`.
 *
 * ── This component makes no decisions ─────────────────────────────────────
 * Which values are safe to render, what URL a stored handle becomes, and what
 * the link says are all `lib/profile/socials.ts`'s answers. That is not an
 * abstraction preference: those questions have to be answered identically by
 * the write path and the render path, and a copy of the rule living in JSX is
 * a copy that no unit test reaches and that quietly diverges the first time
 * either side is edited.
 *
 * So this file renders a list. `renderableSocials` decides what is in it, and
 * has already refused anything whose scheme it cannot vouch for — including
 * values written to `User.socials` by something other than this slice, which
 * is reachable, since the column is free-form TEXT that the seed writes
 * directly.
 *
 * ── Why `rel` and `target` come from constants ────────────────────────────
 * SPEC-010's oracle checks all three `rel` tokens on EVERY link. Spelled per
 * element, the third link is the one that ends up with two of them, and the
 * browser test only catches it if that particular link happens to be on the
 * page it visits. One constant, one place to be wrong, and a unit test that
 * pins it (`tests/unit/profile-socials.test.ts`).
 *
 * `noreferrer` is the one worth naming: without it the destination learns the
 * profile URL a reader came from. `noopener` stops the opened tab reaching
 * back through `window.opener`. `nofollow` is the SEO half and the least
 * important of the three, which is exactly why it is the one people drop.
 */

import type { CSSProperties } from 'react';

import { REL, TARGET, renderableSocials, type StoredSocials } from '../../lib/profile/socials';

export interface SocialLinksProps {
  socials: StoredSocials | null | undefined;
  /** Distinguishes this list in e2e selectors. */
  testId?: string;
  className?: string;
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-4)',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-meta-size)',
};

const linkStyle: CSSProperties = {
  color: 'var(--fg-muted)',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
};

const platformStyle: CSSProperties = {
  color: 'var(--fg-muted)',
};

export function SocialLinks({ socials, testId = 'profile-socials', className }: SocialLinksProps) {
  const links = renderableSocials(socials);

  // Nothing at all rather than an empty `<ul>`: an empty list is still a
  // landmark to a screen reader, announced as a list of zero items for a
  // person who has no links.
  if (links.length === 0) return null;

  return (
    <ul style={listStyle} className={className} data-testid={testId}>
      {links.map((link) => (
        <li key={link.key}>
          <a
            href={link.href}
            rel={REL}
            target={TARGET}
            style={linkStyle}
            data-testid="profile-social-link"
            data-social={link.key}
          >
            {/* The platform name is part of the accessible name rather than a
                `title` or an icon alone: "@ada" three times over is
                indistinguishable in a screen reader's link list, and an
                icon-only link is a link with no name at all. */}
            <span style={platformStyle}>{link.title}</span>
            <span>{link.label}</span>
            {/* Announce the new tab. A link that moves the user out of the app
                without warning is a WCAG 3.2.5 problem, and the visually
                hidden text is the conventional fix. */}
            <span className="visually-hidden">(opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
