/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The article header (SPEC-009).
 *
 * > Header | Title (`--text-h1`), subtitle, author row (avatar, name,
 * > `/@handle` link, Follow button), `publishedAt` formatted via
 * > `lib/format/date.ts`, `readingMinutes`
 *
 * A SERVER component. Everything here is text the page already has, so none of
 * it needs to reach the client bundle — the one interactive thing in the row
 * is `FollowButton`, which is a client component of its own and crosses the
 * boundary by itself. Making the whole header a client component to
 * accommodate one button would ship the title and byline twice: once as HTML,
 * once as props in the RSC payload.
 *
 * ── Why it carries an `id` ───────────────────────────────────────────────
 * `StickyBar` observes this element to decide when the header has scrolled
 * away. The id is supplied by the page rather than hard-coded here so the two
 * sides read the same constant instead of agreeing by coincidence.
 *
 * ── On styling ───────────────────────────────────────────────────────────
 * `app/globals.css` is SPEC-003's (TASK-002) and outside this task's file
 * scope, so the frame reads design tokens through `style` props — the same
 * posture `app/bookmarks/page.tsx` and `/signin` took. The tokens are the
 * design system's; only the composition is local.
 */

import type { CSSProperties } from 'react';

import { FollowButton } from './FollowButton';
import { Avatar } from '../ui/Avatar';
import { formatArticleDate, formatReadingTime, toDateTimeAttribute } from '../../lib/format/date';
import { profileHref } from '../../lib/routes';

export interface ArticleHeaderProps {
  id: string;
  title: string;
  subtitle: string | null;
  author: { name: string; handle: string; avatarPath: string | null };
  /** `null` while an article is still a draft — its author is previewing it. */
  publishedAt: Date | null;
  readingMinutes: number;
}

const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-reading)',
  fontSize: 'var(--text-h1-size)',
  lineHeight: 'var(--text-h1-leading)',
  fontWeight: 700,
  letterSpacing: '-0.012em',
  color: 'var(--fg)',
  margin: 0,
};

const subtitleStyle: CSSProperties = {
  fontFamily: 'var(--font-reading)',
  fontSize: '24px',
  lineHeight: 1.35,
  fontWeight: 400,
  color: 'var(--fg-muted)',
  margin: 'var(--space-3) 0 0',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  marginBlockStart: 'var(--space-6)',
  fontFamily: 'var(--font-ui)',
};

const metaStyle: CSSProperties = {
  fontSize: 'var(--text-meta-size)',
  lineHeight: 'var(--text-meta-leading)',
  color: 'var(--fg-muted)',
};

const nameLinkStyle: CSSProperties = {
  color: 'var(--fg)',
  fontWeight: 600,
  fontSize: 'var(--text-ui-size)',
  textDecoration: 'none',
};

export function ArticleHeader({
  id,
  title,
  subtitle,
  author,
  publishedAt,
  readingMinutes,
}: ArticleHeaderProps) {
  return (
    /* A plain <div>, not a <header>. A `<header>` that is not scoped inside an
       `article`/`aside`/`main`/`nav`/`section` is exposed as a `banner`
       landmark, and `TopNav` already owns the page's one banner — axe reports
       the pair as `landmark-no-duplicate-banner`. The heading below is what
       carries the structure here; the wrapper needs no role at all. */
    <div id={id} data-testid="article-header" style={{ marginBlockEnd: 'var(--space-6)' }}>
      <h1 style={titleStyle} data-testid="article-title">
        {title}
      </h1>
      {subtitle ? (
        <p style={subtitleStyle} data-testid="article-subtitle">
          {subtitle}
        </p>
      ) : null}

      <div style={rowStyle} data-testid="author-row">
        {/* The avatar is decorative here — the author's name is the very next
            element and is a link. Announcing both would read the name twice. */}
        <span aria-hidden="true" style={{ flex: '0 0 auto' }}>
          <Avatar name={author.name} src={author.avatarPath} size="md" />
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <a href={profileHref(author.handle)} style={nameLinkStyle} data-testid="author-name">
            {author.name}
          </a>
          <span style={metaStyle}>
            <a
              href={profileHref(author.handle)}
              style={{ color: 'inherit' }}
              data-testid="author-handle"
            >
              @{author.handle}
            </a>
            {' · '}
            {/* A draft has no publication date yet; the author previewing it
                should see the read time rather than an empty separator. */}
            {publishedAt ? (
              <>
                <time dateTime={toDateTimeAttribute(publishedAt)} data-testid="published-at">
                  {formatArticleDate(publishedAt)}
                </time>
                {' · '}
              </>
            ) : null}
            <span data-testid="reading-time">{formatReadingTime(readingMinutes)}</span>
          </span>
        </div>

        <span style={{ marginInlineStart: 'auto', flex: '0 0 auto' }}>
          <FollowButton compact />
        </span>
      </div>
    </div>
  );
}

export default ArticleHeader;
