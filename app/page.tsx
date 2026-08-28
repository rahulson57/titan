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
 * ── The loading boundary lives INSIDE this file (TASK-018, DEC-047) ───────
 * SPEC-011 requires that "no route shows a blank white frame for more than
 * 200 ms after navigation", and everywhere else in the product that is a
 * segment-level `loading.tsx`. `/` cannot have one: its loading file IS
 * `app/loading.tsx`, and a `loading.tsx` at the app ROOT wraps every page in
 * the product in a Suspense boundary whose fallback flushes before any page
 * below it has resolved. The HTTP status is committed with that first chunk,
 * so `notFound()` anywhere below can only render into an already-open 200 —
 * measured single-variable on a fresh dev server: root file present -> 200 for
 * an unknown article slug, absent -> 404. Restoring that file to give `/` a
 * skeleton would re-break the sealed hard-404 criterion for `/article/[slug]`
 * and both of SPEC-005's draft-privacy assertions.
 *
 * So the boundary is declared here instead, around the part of the page that
 * actually waits. It covers exactly one route — this one, which never calls
 * `notFound()` — and covers nothing nested, so there is no status anywhere
 * that it can pre-empt. That is the whole difference between this and the file
 * that was deleted: scope, not markup.
 *
 * ── Why the split into `FeedSection` is load-bearing ──────────────────────
 * A `<Suspense>` only shows its fallback if something INSIDE it suspends.
 * Wrapping `<FeedList>` while the page component itself awaited `auth()` and
 * the feed query would render nothing until those had already resolved — the
 * boundary would be decoration, and the first frame would still be blank. The
 * awaits therefore moved down into `FeedSection`, leaving this component with
 * only `await searchParams` (resolved from the parsed request, not I/O). The
 * shell — heading and tabs — is emitted immediately; the rows stream in.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the page frame reads design tokens through `style` props —
 * the same arrangement `app/bookmarks/page.tsx` uses and for the same reason.
 * The cards themselves are the design system's `ArticleCard`, unchanged.
 */

import { Suspense, type CSSProperties } from 'react';
import type { Metadata } from 'next';

import { FeedList } from '../components/feed/FeedList';
import { FeedTabs, tabHref } from '../components/feed/FeedTabs';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { auth } from '../lib/auth/session';
import {
  getFeedPage,
  getFollowingPage,
  parseFeedTab,
  type FeedItem,
  type FeedTab,
} from '../lib/feed/queries';
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

const skeletonColumnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-7)',
};

const skeletonRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const skeletonBylineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

/** Three rows: enough to fill the fold, few enough to stay cheap. */
const PLACEHOLDER_ROWS = [0, 1, 2];

/**
 * The first frame of the feed.
 *
 * Same `Skeleton` primitive, same three-row article-card geometry and the same
 * `route-loading` testid as `app/bookmarks/loading.tsx`, `app/search/loading.tsx`
 * and `app/tag/[slug]/loading.tsx` — the identifier the sealed SPEC-011 oracle
 * probes. It is declared here rather than shared from `components/ui/` because
 * that directory is SPEC-003's and outside TASK-018's file scope; the
 * duplication is called out in the proposal as a follow-up worth taking, not
 * an oversight.
 *
 * Note what is NOT in here: the heading and the tabs. Those are real content,
 * they need no data, and they render in the shell above this boundary — so the
 * reader gets the page's identity and its navigation immediately, and only the
 * rows are placeheld.
 */
function FeedSkeleton() {
  return (
    <div style={skeletonColumnStyle} data-testid="route-loading">
      {PLACEHOLDER_ROWS.map((row) => (
        <div key={row} style={skeletonRowStyle}>
          <div style={skeletonBylineStyle}>
            <Skeleton variant="circle" width={24} height={24} />
            <Skeleton variant="text" width="9rem" />
          </div>
          {/* Headline-sized bar, then two lines of dek — the article-card shape. */}
          <Skeleton variant="rect" width="80%" height={28} />
          <Skeleton variant="text" lines={2} />
        </div>
      ))}
    </div>
  );
}

/**
 * Everything on `/` that has to wait for the database: the session read and
 * the ranked page of rows. Kept as its own async component so the `<Suspense>`
 * in `HomePage` has something that genuinely suspends — see the file header.
 */
async function FeedSection({ tab, cursor }: { tab: FeedTab; cursor: string | null }) {
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
  );
}

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const tab = parseFeedTab(first(params.tab));
  const cursor = first(params.cursor) ?? null;

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

      {/*
        `key` re-arms the boundary whenever the tab or the page changes. Without
        it React keeps the resolved subtree mounted across a client-side
        navigation to `?tab=following` or the next cursor, so the reader sits
        looking at the PREVIOUS tab's stories with no indication that anything
        is happening. With it, the same skeleton that covers the first load
        covers every subsequent one.
      */}
      <Suspense key={`${tab}:${cursor ?? ''}`} fallback={<FeedSkeleton />}>
        <FeedSection tab={tab} cursor={cursor} />
      </Suspense>
    </main>
  );
}
