/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { ReactNode } from 'react';

import { Avatar } from './Avatar';
import { Tag } from './Tag';

export interface ArticleCardAuthor {
  name: string;
  /** Profile handle without the `@`. Links to `/@[handle]` (SPEC-011). */
  handle?: string;
  avatarUrl?: string | null;
}

export interface ArticleCardTag {
  slug: string;
  name: string;
}

export interface ArticleCardProps {
  title: string;
  /** Canonical article URL, normally `/article/[slug]`. */
  href: string;
  author: ArticleCardAuthor;
  /** ISO-8601 instant. Rendered in a `<time datetime>` so it stays machine-readable. */
  publishedAt: string;
  /** Plain-text summary. Clamped to two lines by CSS, never truncated in markup. */
  excerpt?: string;
  /** Whole minutes. Omitted from the byline when absent rather than shown as 0. */
  readingMinutes?: number;
  tags?: ArticleCardTag[];
  coverUrl?: string | null;
  /** Trailing slot for engagement controls (clap/bookmark) owned by SPEC-009. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Formats an instant for a byline: "12 Mar 2026".
 *
 * `UTC` is pinned deliberately. The seed corpus is fixed at
 * `2026-01-01T00:00:00Z` and SPEC-002 requires two runs to produce identical
 * output, so a date that rendered in the machine's local zone would make the
 * same row read differently either side of midnight — a real source of the
 * flaky pass SPEC-002 forbids.
 *
 * An unparseable value returns the empty string rather than "Invalid Date":
 * a card with a missing date should lose its date, not display a defect.
 */
export function formatPublishedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** "1 min read" / "7 min read". Anything under a minute still reads as 1. */
export function formatReadingTime(minutes: number): string {
  return `${Math.max(1, Math.round(minutes))} min read`;
}

/**
 * A single article in a list (SPEC-003).
 *
 * Every list surface in the product — the home feed, tag pages, search
 * results, profiles, `/bookmarks` — renders this. It is presentational only:
 * it takes formatted data and emits markup, holds no state, fetches nothing,
 * and knows no route beyond the `href` it is handed.
 *
 * The title is the only link to the article, and it wraps the whole heading
 * rather than the whole card. A card-sized link swallows the byline and tag
 * links inside it (nested anchors are invalid, and screen readers announce
 * the entire card as one enormous link), so the click target stays the
 * headline and the secondary links stay reachable.
 */
export function ArticleCard({
  title,
  href,
  author,
  publishedAt,
  excerpt,
  readingMinutes,
  tags,
  coverUrl,
  actions,
  className,
}: ArticleCardProps) {
  const published = formatPublishedAt(publishedAt);
  const classes = [
    'article-card',
    coverUrl ? 'article-card--with-cover' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} data-testid="article-card">
      <div className="article-card__byline">
        <Avatar name={author.name} src={author.avatarUrl ?? null} size="sm" />
        {author.handle ? (
          <a className="article-card__author" href={`/@${author.handle}`}>
            {author.name}
          </a>
        ) : (
          <span className="article-card__author">{author.name}</span>
        )}
        {published ? (
          <>
            <span aria-hidden="true">·</span>
            <time dateTime={publishedAt}>{published}</time>
          </>
        ) : null}
      </div>

      <h2 className="article-card__title">
        <a className="article-card__link" href={href}>
          {title}
        </a>
      </h2>

      {excerpt ? <p className="article-card__excerpt">{excerpt}</p> : null}

      <div className="article-card__footer">
        {typeof readingMinutes === 'number' ? <span>{formatReadingTime(readingMinutes)}</span> : null}
        {tags?.map((tag) => (
          <Tag key={tag.slug} href={`/tag/${tag.slug}`}>
            {tag.name}
          </Tag>
        ))}
        {actions}
      </div>

      {coverUrl ? (
        // Decorative: the headline immediately beside it is the accessible
        // name for this link target, so an alt text would be read twice.
        //
        // Plain <img> for the same reasons as Avatar: a fixed 112px thumbnail
        // off local disk, no remote origin configured, and a loader the static
        // render suite cannot supply.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="article-card__cover" src={coverUrl} alt="" aria-hidden="true" />
      ) : null}
    </article>
  );
}

export default ArticleCard;
