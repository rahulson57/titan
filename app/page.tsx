/**
 * `/` — the home feed (SPEC-008, SPEC-011's `Feed & Search`, public).
 *
 * > Two tabs: **For you** (default, anonymous-safe) and **Following**
 * > (signed-in only). Empty state: "Nothing here yet" + link to
 * > `/editor/new`.
 *
 * Replaces S01's placeholder wholesale, per DEC-007: "TASK-002 (Design System)
 * and TASK-007 (Feed & Search) MUST REPLACE these two files as their normal
 * work — do not treat their existing content as a contract to preserve."
 *
 * ── Where the work is, and where it is not ────────────────────────────────
 * This file reads two query parameters, asks `lib/feed/queries.ts` for a page
 * of rows, and renders them. It contains no ordering, no scoring and no
 * pagination arithmetic — all of that is in `lib/feed/`, where
 * `tests/unit/feed-*.test.ts` can hold it to SPEC-008's criteria without a
 * browser. A page component that computed its own order would be a second
 * implementation of the ranking formula, which is the one thing SPEC-008's
 * "one canonical formula" heading forbids.
 *
 * ── The lookahead row ─────────────────────────────────────────────────────
 * The page asks for `PAGE_SIZE + 1` rows and renders `PAGE_SIZE`. The extra
 * row is never shown; it answers one question — "is there another page?" —
 * that cannot be answered from a full page alone. Without it the "Older
 * stories" link would appear on the last page whenever that page happened to
 * be exactly full, and lead to the empty state. The alternative is a second
 * `COUNT(*)` over a set that only grows, to learn one bit.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the page frame reads design tokens through `style` props —
 * the same arrangement `app/bookmarks/page.tsx` uses and for the same reason.
 * The cards themselves are the design system's `ArticleCard`, unchanged.
 */

import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { FeedList } from '../components/feed/FeedList';
import { FeedTabs, tabHref } from '../components/feed/FeedTabs';
import { EmptyState } from '../components/ui/EmptyState';
import { auth } from '../lib/auth/session';
import { getFeedPage, getFollowingPage, parseFeedTab, type FeedItem } from '../lib/feed/queries';
import { FEED_PAGE_SIZE } from '../lib/feed/rank';
import { NEW_STORY } from '../lib/routes';

export const metadata: Metadata = {
  title: 'titan',
  description: 'Read and write stories worth the time.',
};

/**
 * Ranked against the clock and, on the Following tab, against the reader's
 * session — so this route can never be statically rendered or shared between
 * visitors. Saying so explicitly documents the intent; `auth()` reading
 * `cookies()` enforces it either way.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  /** Next 15 hands search params to a Server Component as a Promise. */
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

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tab = parseFeedTab(first(params.tab));
  const cursor = first(params.cursor) ?? null;

  const session = await auth();

  // One extra row, never rendered. See the header.
  const limit = FEED_PAGE_SIZE + 1;
  const rows: FeedItem[] =
    tab === 'following'
      ? await getFollowingPage({ viewerId: session?.user.id ?? null, cursor, limit })
      : await getFeedPage({ cursor, limit });

  const items = rows.slice(0, FEED_PAGE_SIZE);
  const last = items[items.length - 1];
  const moreHref =
    rows.length > FEED_PAGE_SIZE && last
      ? `${tabHref(tab)}${tabHref(tab).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(last.cursor)}`
      : null;

  return (
    <main style={columnStyle} data-testid="home-feed" data-tab={tab}>
      {/*
        The page's own H1. Visually hidden rather than absent: every page needs
        exactly one top-level heading for a screen-reader user to orient by,
        and a feed whose first heading is an article title reads as though the
        article IS the page.
      */}
      <h1 className="visually-hidden" style={headingStyle}>
        Stories
      </h1>

      <FeedTabs active={tab} />

      <FeedList
        items={items}
        moreHref={moreHref}
        testId="feed-list"
        empty={
          <EmptyState
            // SPEC-008 fixes this string.
            title="Nothing here yet"
            description={
              tab === 'following'
                ? 'Stories from the people you follow will show up here.'
                : 'Published stories will show up here.'
            }
            action={
              // SPEC-008: the empty state links to `/editor/new`. The same
              // link for both tabs, deliberately — the spec names one empty
              // state for `/`, and an anonymous reader who follows it lands on
              // the sign-in redirect the editor route already owns.
              <a className="btn btn--primary" href={NEW_STORY} data-testid="feed-empty-write">
                Write a story
              </a>
            }
          />
        }
      />
    </main>
  );
}
