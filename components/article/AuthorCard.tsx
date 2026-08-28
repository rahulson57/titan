/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The footer author card (SPEC-009).
 *
 * > Footer | Tag chips → `/tag/[slug]`, clap control, bookmark toggle, author
 * > card with bio + follower count
 *
 * A SERVER component, like `ArticleHeader` and for the same reason: it is text
 * the page already holds. The two interactive pieces — the follow button and
 * the follower count — are client consumers of `FollowProvider`, so they cross
 * the boundary themselves rather than dragging the bio and avatar with them.
 *
 * ── Why the follower count comes from the provider and not a prop ────────
 * The count is rendered here and changed by the button in the header. If this
 * card took its number as a prop it would be a second, frozen copy: following
 * from the header would flip that button and leave "1,204 followers" at the
 * foot of the article unchanged until a reload. `FollowerCount` reads the same
 * optimistic state the buttons write, so one action moves both — including
 * rolling both back together when the action fails.
 */

import type { CSSProperties } from 'react';

import { FollowButton, FollowerCount } from './FollowButton';
import { Avatar } from '../ui/Avatar';
import { profileHref } from '../../lib/routes';

export interface AuthorCardProps {
  author: {
    name: string;
    handle: string;
    bio: string | null;
    avatarPath: string | null;
  };
}

const cardStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-5)',
  alignItems: 'flex-start',
  padding: 'var(--space-6) 0',
  borderBlockStart: '1px solid var(--border)',
  fontFamily: 'var(--font-ui)',
};

const nameStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '20px',
  lineHeight: 1.3,
  fontWeight: 700,
  color: 'var(--fg)',
  textDecoration: 'none',
};

const bioStyle: CSSProperties = {
  margin: 'var(--space-2) 0 0',
  fontSize: 'var(--text-ui-size)',
  lineHeight: 1.5,
  color: 'var(--fg-muted)',
};

export function AuthorCard({ author }: AuthorCardProps) {
  return (
    <section style={cardStyle} data-testid="author-card" aria-labelledby="author-card-name">
      <span aria-hidden="true" style={{ flex: '0 0 auto' }}>
        <Avatar name={author.name} src={author.avatarPath} size="lg" />
      </span>

      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <a id="author-card-name" href={profileHref(author.handle)} style={nameStyle}>
          {author.name}
        </a>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-meta-size)',
            color: 'var(--fg-muted)',
          }}
        >
          <FollowerCount />
        </p>
        {author.bio ? (
          <p style={bioStyle} data-testid="author-bio">
            {author.bio}
          </p>
        ) : null}
      </div>

      <span style={{ flex: '0 0 auto' }}>
        <FollowButton />
      </span>
    </section>
  );
}

export default AuthorCard;
