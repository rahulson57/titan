/**
 * `/tag/[slug]` — one topic's published stories (SPEC-008, public).
 *
 * > Published articles with that tag, newest first, + follower-free tag
 * > header. Empty state: "No articles tagged X yet".
 *
 * "Follower-free" is a scope statement, not a styling one: there is no follow
 * button on a tag in v1, so the header is a heading and a count and nothing
 * else. `SPEC-010` owns following people; nothing owns following topics.
 *
 * ── Why an unknown tag renders rather than 404s ───────────────────────────
 * A slug with no `Tag` row and a slug whose every article is a draft are the
 * same thing to a reader: a topic with nothing to read. Both render the empty
 * state with the slug echoed back, because that is what the criterion asks for
 * — "renders its documented empty state when no rows match" — and because a
 * 404 would leak which tags exist. The distinction is invisible from outside
 * and it should stay that way.
 *
 * `notFound()` is deliberately not imported here. See above; it would be the
 * easy thing and the wrong one.
 */

import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { FeedList } from '../../../components/feed/FeedList';
import { EmptyState } from '../../../components/ui/EmptyState';
import { findTagBySlug, normalizeTagSlug } from '../../../lib/db/tags';
import { getTagPage, type FeedItem } from '../../../lib/feed/queries';
import { FEED_PAGE_SIZE } from '../../../lib/feed/rank';
import { HOME, tagHref } from '../../../lib/routes';

/** Time-ordered and database-backed, so never statically rendered. */
export const dynamic = 'force-dynamic';

interface PageProps {
  /** Next 15 hands route params to a Server Component as a Promise. */
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** What the URL segment resolved to: a queryable slug, or nothing. */
interface TagRoute {
  /** The canonical slug, or null when the segment cannot be one. */
  slug: string | null;
  /** What to show the reader — the slug, or their own text back. */
  label: string;
}

/**
 * Read the slug the way `lib/db/tags.ts` writes it, and never throw doing it.
 *
 * Two hazards, both reachable by typing in the address bar:
 *
 *   - `decodeURIComponent` throws `URIError` on a malformed escape — `/tag/%`
 *     is enough.
 *   - `normalizeTagSlug` throws `InvalidTagSlugError` on anything that is not
 *     2–32 characters of `[a-z0-9-]` — `/tag/x` and `/tag/!!!` both qualify.
 *
 * Either would be an uncaught exception in a Server Component, i.e. a 500 on a
 * public URL that a crawler will find within a day. A tag that cannot exist
 * has nothing published under it, which is the empty state, so that is what it
 * gets — with the reader's own text echoed back (React escapes it) rather than
 * a normalised form that would be a lie about what they asked for.
 *
 * Normalising rather than querying the raw segment matters for the OTHER
 * direction too: tags are stored already-normalised, so `/tag/Design` must
 * reach the same rows as `/tag/design`. Otherwise a capitalised link in
 * someone's article body lands on an empty page for a topic that plainly has
 * articles.
 */
function readSlug(raw: string): TagRoute {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding. The undecoded segment is still the most
    // faithful thing to show, so fall through with it.
  }

  try {
    const slug = normalizeTagSlug(decoded);
    return { slug, label: slug };
  } catch {
    return { slug: null, label: decoded };
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  const route = readSlug(rawSlug);
  const tag = route.slug === null ? null : await findTagBySlug(route.slug);
  const name = tag?.name ?? route.label;
  return { title: `${name} — titan`, description: `Stories tagged ${name}.` };
}

const columnStyle: CSSProperties = {
  maxWidth: 'var(--measure)',
  margin: '0 auto',
  padding: 'var(--space-7) var(--space-5)',
  fontFamily: 'var(--font-ui)',
};

const headerStyle: CSSProperties = {
  borderBlockEnd: '1px solid var(--border)',
  paddingBlockEnd: 'var(--space-5)',
  marginBlockEnd: 'var(--space-7)',
};

const headingStyle: CSSProperties = {
  font: 'var(--text-h1)',
  fontFamily: 'var(--font-reading)',
  fontWeight: 'var(--text-h1-weight)' as CSSProperties['fontWeight'],
  color: 'var(--fg)',
  margin: 0,
};

const countStyle: CSSProperties = {
  color: 'var(--fg-muted)',
  fontSize: 'var(--text-meta-size)',
  marginBlockStart: 'var(--space-2)',
  marginBlockEnd: 0,
};

export default async function TagPage({ params, searchParams }: PageProps) {
  const { slug: rawSlug } = await params;
  const route = readSlug(rawSlug);
  const slug = route.slug;
  const query = await searchParams;
  const cursor = first(query.cursor) ?? null;

  // A segment that cannot be a slug is not queried at all — there is nothing
  // to look it up by, and `findTagBySlug(null)` would be a type error rather
  // than a lookup.
  const [tag, rows] = await Promise.all([
    slug ? findTagBySlug(slug) : Promise.resolve(null),
    // One extra row to decide whether an "older" link belongs. See
    // `app/page.tsx` for why the lookahead beats a second COUNT(*).
    slug
      ? getTagPage({ slug, cursor, limit: FEED_PAGE_SIZE + 1 })
      : Promise.resolve<FeedItem[]>([]),
  ]);

  const name = tag?.name ?? route.label;
  const items = rows.slice(0, FEED_PAGE_SIZE);
  const last = items[items.length - 1];
  const moreHref =
    slug && last && rows.length > FEED_PAGE_SIZE
      ? `${tagHref(slug)}?cursor=${encodeURIComponent(last.cursor)}`
      : null;

  return (
    <main style={columnStyle} data-testid="tag-page" data-tag-slug={slug ?? ''}>
      <header style={headerStyle}>
        <h1 style={headingStyle} data-testid="tag-title">
          {name}
        </h1>
        {items.length > 0 ? (
          <p style={countStyle} data-testid="tag-count">
            {/* Counts what is ON THIS PAGE, and says so, rather than implying a
                total the query never asked for. A "1 234 stories" that costs a
                second aggregate on every tag page is not worth the number. */}
            {items.length === 1 ? '1 story' : `${items.length} stories`}
            {rows.length > FEED_PAGE_SIZE ? ' on this page' : ''}
          </p>
        ) : null}
      </header>

      <FeedList
        items={items}
        moreHref={moreHref}
        testId="tag-feed"
        empty={
          <EmptyState
            // SPEC-008 fixes this string, with the tag substituted.
            title={`No articles tagged ${name} yet`}
            description="Nothing has been published under this topic."
            action={
              <a className="btn btn--secondary" href={HOME} data-testid="tag-empty-home">
                Back to the feed
              </a>
            }
          />
        }
      />
    </main>
  );
}
