/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { CSSProperties, ReactNode } from 'react';

import { ArticleCard } from '../ui/ArticleCard';
import type { FeedItem } from '../../lib/feed/queries';
import { articleHref } from '../../lib/routes';

/**
 * A column of article cards — the shared body of `/`, `/tag/[slug]` and
 * `/search` (SPEC-008).
 *
 * All three discovery surfaces render the same list of the same cards, so the
 * list is one component and each page supplies only what differs: its empty
 * state, and where "older" leads. Three near-identical `.map()` calls in three
 * page files is how the search results quietly stop showing reading time.
 *
 * Presentational and synchronous on purpose: it takes rows, it renders them.
 * Every query lives in `lib/feed/queries.ts` and every page is the async
 * component. That is what lets `tests/unit/*.test.ts` cover the ordering
 * without rendering anything, and lets this be checked without a database.
 *
 * ── The excerpt, and why search passes its own ────────────────────────────
 * A feed card's excerpt is the first ~180 characters of the body. A SEARCH
 * card's excerpt should be the text AROUND THE MATCH — a result whose excerpt
 * never contains the searched word reads as a wrong result even when the
 * ranking is right. `FeedItem.snippet` carries FTS5's
 * `snippet(article_fts, 2, ...)` output when the row came from a search, and
 * this component prefers it when present.
 *
 * ── Why the highlight markup is stripped rather than rendered ─────────────
 * SPEC-008 specifies the snippet with `'<mark>'`/`'</mark>'` delimiters, and
 * the query asks for exactly that. They are removed here rather than injected
 * into the DOM, for two independent reasons and either one alone would settle
 * it:
 *
 *   1. `snippet()` does NOT escape the text it wraps. It is built from
 *      `bodyText`, which is reader-authored prose, so rendering the result as
 *      HTML would execute anything an author put in their article body. There
 *      is a safe way to do this — split on the delimiters and emit real
 *      `<mark>` elements, which React escapes — but:
 *   2. `ArticleCard.excerpt` is typed `string`, and `ArticleCard` belongs to
 *      SPEC-003 (TASK-002), outside this slice's file scope. Widening it to
 *      `ReactNode` is a change to a shared component that this task may not
 *      make.
 *
 * So the snippet keeps its job — an excerpt centred on the match — and loses
 * only the emphasis. Worth revisiting if a later slice widens the prop; the
 * parsing half is three lines and the delimiters are already in the string.
 */

export interface FeedListProps {
  items: readonly FeedItem[];
  /** Rendered instead of the list when `items` is empty. */
  empty: ReactNode;
  /**
   * `?cursor=` link target for the next page, or null when this is the last
   * one. A plain link, so the URL stays the state and the back button works.
   */
  moreHref?: string | null;
  /** Label on the "older" link — each surface names its own content. */
  moreLabel?: string;
  /** Distinguishes the three surfaces in e2e selectors. */
  testId?: string;
}

/** Plain-text excerpt length when the row carries no snippet. */
const EXCERPT_LENGTH = 180;

/** Strip FTS5's highlight delimiters. See the header for why they are dropped. */
function stripHighlights(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, '');
}

/**
 * First ~180 characters of the body, cut on a word boundary.
 *
 * Cut on whitespace rather than mid-word: `…he was compl…` reads as a bug. A
 * body shorter than the limit is returned whole, with no ellipsis, because an
 * ellipsis promising more text when there is none is a small lie the reader
 * notices.
 */
export function excerptFrom(item: Pick<FeedItem, 'bodyText' | 'snippet'>): string | undefined {
  if (item.snippet) {
    const stripped = stripHighlights(item.snippet).trim();
    if (stripped.length > 0) return stripped;
  }

  const text = item.bodyText.trim().replace(/\s+/g, ' ');
  if (text.length === 0) return undefined;
  if (text.length <= EXCERPT_LENGTH) return text;

  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-7)',
};

const moreStyle: CSSProperties = {
  display: 'inline-block',
  marginBlockStart: 'var(--space-7)',
  color: 'var(--fg)',
  fontSize: 'var(--text-meta-size)',
  fontFamily: 'var(--font-ui)',
};

export function FeedList({
  items,
  empty,
  moreHref = null,
  moreLabel = 'Older stories',
  testId = 'feed-list',
}: FeedListProps) {
  if (items.length === 0) return <>{empty}</>;

  return (
    <>
      <ul style={listStyle} data-testid={testId}>
        {items.map((item) => (
          <li key={item.id} data-testid="feed-item" data-article-id={item.id}>
            <ArticleCard
              title={item.title}
              href={articleHref(item.slug)}
              author={{
                name: item.author.name,
                handle: item.author.handle,
                avatarUrl: item.author.avatarPath,
              }}
              publishedAt={item.publishedAt.toISOString()}
              excerpt={excerptFrom(item)}
              readingMinutes={item.readingMinutes}
              tags={item.tags}
              coverUrl={item.coverPath}
            />
          </li>
        ))}
      </ul>

      {moreHref ? (
        <a style={moreStyle} href={moreHref} data-testid="feed-more">
          {moreLabel}
        </a>
      ) : null}
    </>
  );
}

export default FeedList;
