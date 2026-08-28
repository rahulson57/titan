/**
 * `/search?q=` — full-text search over published stories (SPEC-008, public).
 *
 * > FTS5 results over title + subtitle + bodyText, ranked by bm25. Empty
 * > state: "No results for X" + 5 popular tags.
 *
 * ── Two empty states, not one ─────────────────────────────────────────────
 * `/search` with no query and `/search?q=xyzzy` are different situations and
 * showing the same thing for both is a small but real lie. The first has not
 * been asked anything yet — "Search stories" and the popular tags are an
 * invitation. The second WAS asked and found nothing — "No results for xyzzy"
 * is a report, and the tags are a way out. SPEC-008 names the second; the
 * first is what the route does before the reader has typed, and it must not
 * claim there are no results for a search nobody ran.
 *
 * ── Why the query is echoed but never interpolated ────────────────────────
 * `q` is the most attacker-reachable string on the site: it appears in the
 * heading, in the field's value, and it goes to SQLite. Each of those is
 * handled by the thing that owns the hazard, and none of them by this file:
 *
 *   - Into the DOM: it is a React child and an attribute value, so React
 *     escapes it. There is no `dangerouslySetInnerHTML` on this page — see
 *     `components/feed/FeedList.tsx` for why even the FTS5 snippet's own
 *     `<mark>` delimiters are stripped rather than rendered.
 *   - Into FTS5: `lib/search/query.ts` quotes every token, which turns
 *     operators into literals. A bare `"` or `*` reaching `MATCH` is an
 *     `fts5: syntax error`, i.e. a 500 on a URL anyone can construct.
 *   - Into SQL: the match expression is a bound parameter, never
 *     concatenated.
 *
 * ── Why there is no "older results" link ──────────────────────────────────
 * SPEC-008 specifies cursor pagination for the FEED and says nothing about
 * paging search. bm25 is not a stable sort key across index writes the way
 * `publishedAt` is, so a cursor over it would be a paging session that can
 * repeat rows — the exact defect the feed's cursor exists to prevent. One
 * ranked page of the best matches is what the spec asks for, and it is the
 * honest thing to ship; deep search paging needs a design decision that is not
 * this slice's to make.
 */

import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { FeedList } from '../../components/feed/FeedList';
import { SearchBox } from '../../components/feed/SearchBox';
import { EmptyState } from '../../components/ui/EmptyState';
import { Tag } from '../../components/ui/Tag';
import { getPopularTags, type PopularTag } from '../../lib/feed/queries';
import { FEED_PAGE_SIZE } from '../../lib/feed/rank';
import { searchArticles } from '../../lib/search/fts';
import { parseSearchQuery } from '../../lib/search/query';
import { tagHref } from '../../lib/routes';

export const metadata: Metadata = {
  title: 'Search — titan',
  description: 'Search published stories.',
};

/** Reads `?q=` and the database on every request. */
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const columnStyle: CSSProperties = {
  maxWidth: 'var(--measure)',
  margin: '0 auto',
  padding: 'var(--space-7) var(--space-5)',
  fontFamily: 'var(--font-ui)',
};

const headingStyle: CSSProperties = {
  font: 'var(--text-h1)',
  fontFamily: 'var(--font-reading)',
  fontWeight: 'var(--text-h1-weight)' as CSSProperties['fontWeight'],
  color: 'var(--fg)',
  marginBlockEnd: 'var(--space-5)',
};

const countStyle: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
  marginBlockEnd: 'var(--space-7)',
};

const tagRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
  marginBlockStart: 'var(--space-3)',
};

/** The "5 popular tags" the spec puts in the empty state. */
function PopularTags({ tags }: { tags: readonly PopularTag[] }) {
  if (tags.length === 0) return null;
  return (
    <span data-testid="popular-tags">
      <span style={{ display: 'block' }}>Popular topics</span>
      <span style={tagRowStyle}>
        {tags.map((tag) => (
          <Tag key={tag.slug} href={tagHref(tag.slug)}>
            {tag.name}
          </Tag>
        ))}
      </span>
    </span>
  );
}

export default async function SearchPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const parsed = parseSearchQuery(first(params.q));

  // The tags are wanted in BOTH empty states, and the search is wanted only
  // when there is something to search for. Issued together so a query with no
  // results costs one round trip rather than two.
  const [items, popular] = await Promise.all([
    parsed.isEmpty ? Promise.resolve([]) : searchArticles(parsed.raw, { limit: FEED_PAGE_SIZE }),
    getPopularTags(),
  ]);

  return (
    <main style={columnStyle} data-testid="search-page" data-query={parsed.raw}>
      <h1 style={headingStyle}>Search</h1>

      <SearchBox defaultQuery={parsed.raw} />

      {items.length > 0 ? (
        <p style={countStyle} data-testid="search-count" aria-live="polite">
          {items.length === 1 ? '1 story' : `${items.length} stories`} for “{parsed.raw}”
        </p>
      ) : null}

      <FeedList
        items={items}
        testId="search-results"
        empty={
          parsed.isEmpty ? (
            <EmptyState
              title="Search stories"
              description="Type a word or two above to search titles, subtitles and article text."
              action={<PopularTags tags={popular} />}
            />
          ) : (
            <EmptyState
              // SPEC-008 fixes this string, with the query substituted.
              title={`No results for ${parsed.raw}`}
              description="Try fewer words, or a different spelling."
              action={<PopularTags tags={popular} />}
            />
          )
        }
      />
    </main>
  );
}
