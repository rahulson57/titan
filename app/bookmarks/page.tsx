/**
 * `/bookmarks` — the reader's saved library (SPEC-011, App Shell, signed-in).
 *
 * > "Reverse-chronological by `Bookmark.createdAt`, cursor-paginated at page
 * >  size 20, `ArticleCard` rows with an inline un-bookmark control that
 * >  removes the row from the list without a full reload. Empty state:
 * >  'Nothing saved yet' + link to `/`."
 *
 * ── Two independent gates on "signed-in", and why both exist ──────────────
 * `middleware.ts` already bounces a request with no `titan.session` cookie to
 * `/signin?next=/bookmarks`. This page checks again, and the duplication is
 * not redundancy — the two checks answer different questions:
 *
 *   - The middleware runs on the Edge runtime, which has no Prisma and no
 *     SQLite, so it can only ask *"is a cookie present?"*. A forged or expired
 *     cookie sails straight through it.
 *   - This page runs on the server with the database, so `auth()` asks the
 *     question that matters: *"does this cookie name a live session?"*
 *
 * Without the check here, a hand-written cookie would be a login for this
 * route. `lib/auth/session.ts` says the same thing at greater length; the rule
 * is that the middleware is a redirector and the page is the boundary.
 *
 * The redirect target is built by `signInHref`, so it is spelled the same way
 * the middleware spells it and `safeNextPath` re-validates it on the way back
 * out — one `?next=` contract, three call sites, no second encoding rule.
 *
 * ── Where the query lives, and why not here ───────────────────────────────
 * SPEC-004's repository layer had no "list this reader's bookmarks" function
 * when this page was written, and `lib/db/**` was outside this task's original
 * file scope. Reaching the data through `getDb()` from the page would have
 * passed SPEC-004's machine-checked boundary rule — but it would have left a
 * hand-written query in the app layer behind a TODO that no scheduled task
 * owned, which is deferred debt with no owner.
 *
 * DEC-026 settles it: the query is `listBookmarkedArticles` in
 * `lib/db/social.ts`, the module that owns `Bookmark`, and this page is left
 * with rendering. Why the pagination is cursor-based rather than offset, and
 * why the sort is a pair of columns rather than `createdAt` alone, is
 * documented there with the query it constrains.
 *
 * ── On styling ────────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the page frame reads design tokens through `style` props. The
 * rows themselves are the design system's `ArticleCard`, unchanged.
 */

import { redirect } from 'next/navigation';
import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { removeBookmarkAction } from './actions';
import { ArticleCard } from '../../components/ui/ArticleCard';
import { EmptyState } from '../../components/ui/EmptyState';
import { auth } from '../../lib/auth/session';
import { BOOKMARKS_PAGE_SIZE, listBookmarkedArticles } from '../../lib/db/social';
import { BOOKMARKS, HOME, articleHref, signInHref } from '../../lib/routes';

export const metadata: Metadata = {
  title: 'Bookmarks',
};

/**
 * The session cookie makes this route per-reader by construction, so it can
 * never be statically rendered or shared between users. Saying so explicitly
 * documents the intent; `auth()` reading `cookies()` enforces it either way.
 */
export const dynamic = 'force-dynamic';

/**
 * SPEC-011: "cursor-paginated at page size 20".
 *
 * Re-exported from the repository rather than restated, so there is one page
 * size in the product. A second literal here would be correct on the day it
 * was written and would drift the first time either half changed.
 */
export const PAGE_SIZE = BOOKMARKS_PAGE_SIZE;

/** Plain-text summary length. Two lines at the card's measure, roughly. */
const EXCERPT_LENGTH = 180;

/**
 * First ~180 characters of the body, cut on a word boundary.
 *
 * Cut on whitespace rather than mid-word: `…he was compl…` reads as a bug.
 * A body shorter than the limit is returned whole, with no ellipsis, because
 * an ellipsis that promises more text when there is none is a small lie the
 * reader notices.
 */
function excerptFrom(bodyText: string): string | undefined {
  const text = bodyText.trim().replace(/\s+/g, ' ');
  if (text.length === 0) return undefined;
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

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
  marginBlockEnd: 'var(--space-7)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-7)',
};

const removeButtonStyle: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 'var(--space-1)',
  cursor: 'pointer',
  color: 'var(--fg-muted)',
  font: 'inherit',
  fontSize: 'var(--text-meta-size)',
  textDecoration: 'underline',
};

const moreStyle: CSSProperties = {
  display: 'inline-block',
  marginBlockStart: 'var(--space-7)',
  color: 'var(--fg)',
  fontSize: 'var(--text-meta-size)',
};

export default async function BookmarksPage({ searchParams }: PageProps) {
  const session = await auth();
  // The authoritative check. See the header: the middleware only saw a cookie.
  if (!session) redirect(signInHref(BOOKMARKS));

  const params = await searchParams;
  const cursor = first(params.cursor) ?? null;

  const { items, nextCursor } = await listBookmarkedArticles(session.user.id, {
    cursor,
    take: PAGE_SIZE,
  });

  return (
    <main style={columnStyle} data-testid="bookmarks-page">
      <h1 style={headingStyle}>Bookmarks</h1>

      {items.length === 0 ? (
        <EmptyState
          // SPEC-011 fixes this string. It is the empty state's own heading.
          title="Nothing saved yet"
          description="Stories you bookmark while reading show up here."
          action={
            <a href={HOME} data-testid="bookmarks-empty-home">
              Find something to read
            </a>
          }
        />
      ) : (
        <ul style={listStyle} data-testid="bookmarks-list">
          {items.map((article) => (
            <li key={article.id} data-testid="bookmark-row" data-article-id={article.id}>
              <ArticleCard
                title={article.title}
                href={articleHref(article.slug)}
                author={{
                  name: article.author.name,
                  handle: article.author.handle,
                  avatarUrl: article.author.avatarPath,
                }}
                // The article's own publication instant, not the bookmark's.
                // The card's byline is about the story; `bookmarkedAt` below is
                // only the sort key, and showing it would tell the reader when
                // they clicked save, which is not what a byline means.
                publishedAt={(article.publishedAt ?? article.createdAt).toISOString()}
                excerpt={excerptFrom(article.bodyText)}
                readingMinutes={article.readingMinutes}
                tags={article.tags}
                coverUrl={article.coverPath}
                actions={
                  // The inline un-bookmark control. A form posting to a Server
                  // Action, so it needs no client JavaScript and still removes
                  // the row without a navigation — see app/bookmarks/actions.ts
                  // for why that is a property of the action rather than
                  // something engineered on top of it.
                  <form action={removeBookmarkAction} style={{ margin: 0 }}>
                    <input type="hidden" name="articleId" value={article.id} />
                    <button
                      type="submit"
                      style={removeButtonStyle}
                      // Named per row, so a screen-reader user hearing a list
                      // of "Remove" buttons knows which story each one drops.
                      aria-label={`Remove ${article.title} from bookmarks`}
                      data-testid="bookmark-remove"
                    >
                      Remove
                    </button>
                  </form>
                }
              />
              {/* Machine-readable save time: the sort key, available to the
                  test that asserts `createdAt DESC` without needing it on
                  screen. */}
              <time
                className="visually-hidden"
                dateTime={article.bookmarkedAt.toISOString()}
                data-testid="bookmark-saved-at"
              >
                {article.bookmarkedAt.toISOString()}
              </time>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        // A plain link, not an infinite scroller: the URL stays the state, the
        // back button works, and the page needs no client JavaScript at all.
        <a
          style={moreStyle}
          href={`${BOOKMARKS}?cursor=${encodeURIComponent(nextCursor)}`}
          data-testid="bookmarks-next"
        >
          Older bookmarks
        </a>
      ) : null}
    </main>
  );
}
