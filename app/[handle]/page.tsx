/**
 * `/@[handle]` — the public author profile (SPEC-010).
 *
 * ── Why this directory is `[handle]` and not `@[handle]` (DEC-049) ────────
 * SPEC-010 and SPEC-011 both name the route `/@[handle]`, and that is exactly
 * the URL this file serves. It cannot, however, be named for it. Next's
 * `normalizeAppPath` drops any path segment beginning with `@` as a
 * parallel-route slot:
 *
 *     // next/dist/shared/lib/router/utils/app-paths.js
 *     if (segment[0] === '@') { return pathname }
 *
 * so `app/@[handle]/page.tsx` normalizes to `/`, collides with
 * `app/page.tsx`, and 500s **every route in the app** — not just this one.
 * That was measured twice, independently, on a running dev server before this
 * file was written. `%40[handle]` is not an escape either: `route-regex.js`
 * special-cases `%5F` -> `_` and nothing else, so it would serve `/%40x`.
 *
 * `lib/routes.ts` carries the file->URL equivalence, and
 * `tests/unit/route-map.test.ts` pins it, so the closed-world route sweep
 * still holds.
 *
 * ── The cost of a root dynamic segment, and the guard that pays it ────────
 * `app/[handle]/` is the catch-all for every unmatched single-segment URL, so
 * `/nonexistent` routes *here* rather than to `not-found`. The first thing
 * this page does is refuse anything that is not a handle reference: no leading
 * `@` means this URL was never a profile, and it gets `notFound()` before a
 * query is built. Without that guard the profile page silently becomes the
 * app's 404 handler, which is a different page with a different meaning and a
 * different `<title>`.
 *
 * Static routes still win over a dynamic sibling in Next's matcher, so
 * `/search`, `/bookmarks`, `/signin`, `/settings/profile`, `/tag/*`,
 * `/editor/*` and `/article/*` are unaffected — verified against a running
 * server, not assumed.
 *
 * ── The Drafts/Bookmarks rule is enforced HERE, not in the tab bar ────────
 * `ProfileTabs` omits the owner-only tabs from the DOM for everyone else,
 * which is what SPEC-010's "hidden entirely from other viewers" asks for. But
 * that is a disclosure control: anyone can type `?tab=drafts`. So the tab is
 * resolved through `parseProfileTab(value, isOwner)` BEFORE anything is
 * queried, and a stranger asking for drafts is served the published list. The
 * page never constructs a draft query for a viewer who may not see one.
 */

import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';
import type { Metadata } from 'next';

import { FollowButton, FollowProvider } from '../../components/article/FollowButton';
import { ProfileHeader } from '../../components/profile/ProfileHeader';
import { ProfileTabs, parseProfileTab, profileTabHref, type ProfileTab } from '../../components/profile/ProfileTabs';
import { excerptFrom } from '../../components/feed/FeedList';
import { ArticleCard } from '../../components/ui/ArticleCard';
import { EmptyState } from '../../components/ui/EmptyState';
import { auth, ownsProfile } from '../../lib/auth/session';
import {
  ARTICLE_STATUS,
  PROFILE_PAGE_SIZE,
  countArticlesByAuthor,
  listArticlesByAuthor,
} from '../../lib/db/articles';
import { listBookmarkedArticles } from '../../lib/db/social';
import { findUserByHandle, type UserRecord } from '../../lib/db/users';
import { readFollowState } from '../../lib/engage/follow';
import { HOME, articleHref, profileHref } from '../../lib/routes';

/** Live counts and a viewer-dependent tab. Never statically rendered. */
export const dynamic = 'force-dynamic';

interface PageProps {
  /** Next 15 hands route params to a Server Component as a Promise. */
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The bare handle this URL names, or `null` if it names no profile at all.
 *
 * Two independent reasons to return `null`, and both must 404 rather than
 * throw — an uncaught exception in a Server Component is a 500 on a public URL
 * that a crawler will find within a day:
 *
 *   - **No leading `@`.** `/nonexistent` is not a profile URL. See the header:
 *     this is what stops the root dynamic segment swallowing every unmatched
 *     path.
 *   - **`decodeURIComponent` throws** on a malformed escape; `/%` is enough.
 *
 * The handle itself is NOT validated here. `findUserByHandle` already returns
 * `null` for anything that cannot be a handle, so a second pattern check would
 * be a second place for the rule to drift from `lib/db/users.ts`.
 */
export function handleFromSegment(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith('@')) return null;
  const handle = decoded.slice(1);
  return handle.length === 0 ? null : handle;
}

async function loadProfile(rawHandle: string): Promise<UserRecord> {
  const handle = handleFromSegment(rawHandle);
  if (handle === null) notFound();
  const user = await findUserByHandle(handle);
  if (!user) notFound();
  return user;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { handle: raw } = await params;
  const handle = handleFromSegment(raw);
  const user = handle === null ? null : await findUserByHandle(handle);
  if (!user) return { title: 'Profile not found — titan' };

  return {
    title: `${user.name} (@${user.handle}) — titan`,
    // The bio verbatim, and nothing invented when there is none: a description
    // that says "Stories by X on titan" for every author is worse than absent,
    // because it fills the slot that would otherwise show the first line of
    // their writing.
    description: user.bio ?? undefined,
    alternates: { canonical: profileHref(user.handle) },
  };
}

const columnStyle: CSSProperties = {
  maxWidth: 'var(--breakout-max)',
  margin: '0 auto',
  padding: 'var(--space-5) var(--space-4) var(--space-8)',
  fontFamily: 'var(--font-ui)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 'var(--space-7) var(--space-5) 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-7)',
};

const moreStyle: CSSProperties = {
  display: 'inline-block',
  margin: 'var(--space-7) 0 0 var(--space-5)',
  color: 'var(--fg)',
  fontSize: 'var(--text-meta-size)',
};

/** One row, flattened to what `ArticleCard` takes. */
interface ProfileRow {
  id: string;
  slug: string;
  title: string;
  bodyText: string;
  coverPath: string | null;
  readingMinutes: number;
  /** The date the card shows. See `dateFor`. */
  date: Date;
  tags: { slug: string; name: string }[];
  author: { name: string; handle: string; avatarPath: string | null };
}

/**
 * Which instant a card shows, per tab.
 *
 * A DRAFT has `publishedAt = null` by construction, so the Drafts tab shows
 * `updatedAt` — the thing its author actually wants to see, and the key the
 * repository sorts that tab by. Showing a blank date, or falling back to
 * `createdAt` while sorting by `updatedAt`, would put the list in an order the
 * dates do not explain.
 */
function dateFor(row: { publishedAt: Date | null; updatedAt: Date }): Date {
  return row.publishedAt ?? row.updatedAt;
}

const EMPTY_COPY: Record<ProfileTab, { title: string; description: string }> = {
  published: {
    title: 'Nothing published yet',
    description: 'When this author publishes a story, it will appear here.',
  },
  drafts: {
    title: 'No drafts',
    description: 'Drafts you start will wait here until you publish them.',
  },
  bookmarks: {
    title: 'Nothing saved yet',
    description: 'Stories you bookmark will be collected here.',
  },
};

export default async function ProfilePage({ params, searchParams }: PageProps) {
  const { handle: rawHandle } = await params;
  const user = await loadProfile(rawHandle);

  const query = await searchParams;
  const cursor = first(query.cursor) ?? null;

  // The session is resolved against the database, not against the presence of
  // a cookie — `middleware.ts` cannot do that, and this is a page that shows
  // different rows to different viewers.
  const session = await auth();
  const isOwner = ownsProfile(session?.user ?? null, user.id);

  // Resolved against the VIEWER before any query is built. See the header.
  const tab = parseProfileTab(first(query.tab), isOwner);

  const author = { name: user.name, handle: user.handle, avatarPath: user.avatarPath };

  // `readFollowState` is SPEC-009's read and it returns BOTH halves this page
  // needs — the public `COUNT(*)` the header prints, and whether this viewer is
  // one of them. It is deliberately used in place of the bare
  // `getFollowerCount` this page used to call (it is the same query: see
  // `lib/engage/follow.ts`), so the number beside the button and the number in
  // the stats line cannot disagree, and so no second follower-count read is
  // introduced for the control.
  const [follow, publishedCount, page] = await Promise.all([
    readFollowState(session?.user ?? null, user.id),
    countArticlesByAuthor(user.id, ARTICLE_STATUS.PUBLISHED),
    loadTab(user, tab, cursor),
  ]);

  const rows: ProfileRow[] = page.items.map((item) => ({
    id: item.id,
    slug: item.slug,
    title: item.title,
    bodyText: item.bodyText,
    coverPath: item.coverPath,
    readingMinutes: item.readingMinutes,
    date: dateFor(item),
    tags: item.tags,
    // A bookmarked story belongs to whoever wrote it; the other two tabs are
    // this profile's own work. Attributing a bookmark to the profile owner
    // would be a byline that is simply false.
    author: 'author' in item && item.author ? item.author : author,
  }));

  const moreHref =
    page.nextCursor === null
      ? null
      : `${profileTabHref(user.handle, tab)}${
          profileTabHref(user.handle, tab).includes('?') ? '&' : '?'
        }cursor=${encodeURIComponent(page.nextCursor)}`;

  const copy = EMPTY_COPY[tab];

  return (
    <main style={columnStyle} data-testid="profile-page" data-handle={user.handle} data-tab={tab}>
      <ProfileHeader
        name={user.name}
        handle={user.handle}
        bio={user.bio}
        avatarPath={user.avatarPath}
        coverPath={user.coverPath}
        socials={user.socials}
        followerCount={follow.followerCount}
        publishedCount={publishedCount}
        isOwner={isOwner}
        // SPEC-010's action region, filled with SPEC-009's own control rather
        // than a second one built here (TASK-021). `followAction` takes an
        // author id and nothing else and does not revalidate a path, so it
        // works from this surface unchanged; the one article-shaped thing it
        // carried was the anonymous sign-in destination, now `returnTo`.
        //
        // TWO independent things keep a self-follow off this page, and both
        // are kept on purpose:
        //   1. `ProfileHeader` does not consult this slot at all when
        //      `isOwner` — the structural half, which no caller can undo.
        //   2. `isSelf` here makes `FollowButton` render `null` regardless —
        //      the same rule the article page relies on.
        // Either alone would be correct today. Together, removing one does not
        // silently put a "Follow yourself" button on somebody's own profile.
        action={
          <FollowProvider
            authorId={user.id}
            authorName={user.name}
            // No article to come back to on a profile — this is the whole
            // reason the prop is a destination and not a slug.
            returnTo={profileHref(user.handle)}
            signedIn={session?.user != null}
            isSelf={isOwner}
            initialFollowing={follow.following}
            initialFollowerCount={follow.followerCount}
          >
            <FollowButton compact />
          </FollowProvider>
        }
      />

      <ProfileTabs handle={user.handle} active={tab} isOwner={isOwner} />

      {rows.length === 0 ? (
        <div style={{ padding: 'var(--space-7) var(--space-5) 0' }}>
          <EmptyState
            title={copy.title}
            description={copy.description}
            action={
              <a className="btn btn--secondary" href={HOME} data-testid="profile-empty-home">
                Back to the feed
              </a>
            }
          />
        </div>
      ) : (
        <ul style={listStyle} data-testid="profile-feed">
          {rows.map((row) => (
            <li key={row.id}>
              <ArticleCard
                title={row.title}
                href={articleHref(row.slug)}
                author={{
                  name: row.author.name,
                  handle: row.author.handle,
                  avatarUrl: row.author.avatarPath,
                }}
                publishedAt={row.date.toISOString()}
                excerpt={excerptFrom({ bodyText: row.bodyText })}
                readingMinutes={row.readingMinutes}
                tags={row.tags}
                coverUrl={row.coverPath}
              />
            </li>
          ))}
        </ul>
      )}

      {moreHref ? (
        <a style={moreStyle} href={moreHref} data-testid="profile-more">
          Older stories
        </a>
      ) : null}
    </main>
  );
}

/**
 * The rows for one tab.
 *
 * Every branch returns the same `{ items, nextCursor }` shape so the render
 * below has no per-tab branching — three shapes would mean three chances to
 * render the wrong date or drop the byline on one tab only.
 *
 * This function is only ever reached with a tab the viewer is allowed to see;
 * `parseProfileTab` has already downgraded anything else.
 */
async function loadTab(
  user: UserRecord,
  tab: ProfileTab,
  cursor: string | null,
): Promise<{
  items: {
    id: string;
    slug: string;
    title: string;
    bodyText: string;
    coverPath: string | null;
    readingMinutes: number;
    publishedAt: Date | null;
    updatedAt: Date;
    tags: { slug: string; name: string }[];
    author?: { name: string; handle: string; avatarPath: string | null };
  }[];
  nextCursor: string | null;
}> {
  if (tab === 'bookmarks') {
    const page = await listBookmarkedArticles(user.id, { take: PROFILE_PAGE_SIZE, cursor });
    return {
      items: page.items.map((item) => ({
        ...item,
        // A bookmark row carries the save instant and the publication instant
        // separately, and `BookmarkedArticle` has no `updatedAt`. The card
        // should show when the story was published; an unpublished saved story
        // falls back to when it was saved, which is the only date this row
        // knows to be meaningful.
        updatedAt: item.bookmarkedAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  const page = await listArticlesByAuthor(user.id, {
    status: tab === 'drafts' ? ARTICLE_STATUS.DRAFT : ARTICLE_STATUS.PUBLISHED,
    take: PROFILE_PAGE_SIZE,
    cursor,
  });
  return { items: page.items, nextCursor: page.nextCursor };
}
