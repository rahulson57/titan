/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * `/article/[slug]` — the reading surface (SPEC-009).
 *
 * A server component. The article body is the LCP element and the largest
 * thing on the page, so it is rendered as HTML on the server and never crosses
 * into the client bundle; the four interactive pieces (progress bar, sticky
 * bar, and the engagement controls) are the only client code here.
 *
 * ── Routing ──────────────────────────────────────────────────────────────
 * > `/article/[slug]` — slug is the only public article identifier; a request
 * > for an unknown slug returns Next's 404 page, never a 500.
 *
 * `notFound()` is called for BOTH an unknown slug and a draft the viewer may
 * not read (SPEC-005: *"Drafts are visible ONLY to their author"*, and
 * SPEC-011's route table: *"DRAFT → 404 for non-author"*). Deliberately the
 * same answer: a 403 on a draft would confirm the article exists, which is
 * the fact the rule is protecting.
 *
 * ── Why the providers wrap the whole article ─────────────────────────────
 * The clap and bookmark controls appear twice (footer and sticky bar) and the
 * follow control appears twice (header row and author card). Each pair must
 * show one number. The providers exported by those components hold that state
 * and are wrapped around everything that reads it — which only a component
 * above both can do, and this page is it. See `components/article/ClapButton.tsx`
 * for why the alternative (state per button) is a visible defect rather than a
 * tidiness question.
 *
 * ── Why `force-dynamic` ──────────────────────────────────────────────────
 * Every render reads the session cookie to decide the controls' state, so the
 * page is per-reader and can never be cached or shared. `auth()` reading
 * `cookies()` already forces this; saying it out loud documents the intent.
 *
 * ── On styling ───────────────────────────────────────────────────────────
 * `app/globals.css` belongs to SPEC-003 (TASK-002) and is outside this task's
 * file scope, so the page frame reads design tokens through `style` props —
 * the posture `app/bookmarks/page.tsx` and the auth pages already established.
 * The article column and the body use the design system's own `.article-column`
 * and `Prose`, unchanged.
 */

import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';

import { ArticleHeader } from '../../../components/article/ArticleHeader';
import { AuthorCard } from '../../../components/article/AuthorCard';
import { BookmarkButton, BookmarkProvider } from '../../../components/article/BookmarkButton';
import { ClapButton, ClapProvider } from '../../../components/article/ClapButton';
import { FollowProvider } from '../../../components/article/FollowButton';
import { ProgressBar } from '../../../components/article/ProgressBar';
import { StickyBar } from '../../../components/article/StickyBar';
import { Prose } from '../../../components/ui/Prose';
import { Tag } from '../../../components/ui/Tag';
import { auth, canViewArticle } from '../../../lib/auth/session';
import { getArticleBySlug } from '../../../lib/db/articles';
import { listTagsForArticle } from '../../../lib/db/tags';
import { findUserById } from '../../../lib/db/users';
import { readBookmarkState } from '../../../lib/engage/bookmark';
import { CLAP_BURST_MS, MAX_CLAPS_PER_READER, readClapState } from '../../../lib/engage/clap';
import { readFollowState } from '../../../lib/engage/follow';
import { tagHref } from '../../../lib/routes';

export const dynamic = 'force-dynamic';

/** Anchors shared by the page and the two scroll-driven client components. */
const HEADER_ID = 'article-header';
const BODY_ID = 'article-body';

/** SPEC-009: "max 1024px wide". */
const COVER_WIDTH = 1024;
/**
 * The cover's rendered height.
 *
 * `Article` stores `coverPath` and nothing else — no intrinsic width or height
 * (SPEC-004 owns the schema and this task may not extend it). `next/image`
 * needs explicit dimensions to reserve the box, which is the whole point of
 * the criterion this serves ("Cumulative Layout Shift on the article page is
 * < 0.1 with a cover image present"). So the page fixes a 16:9 frame and
 * `object-fit: cover` crops whatever the author uploaded into it.
 *
 * The trade is deliberate: a fixed ratio can crop a portrait cover, but it
 * reserves the right space before the bytes arrive. Reading the real ratio
 * would mean either storing it (a schema change, not this slice's) or probing
 * the file on every render (an fs read in the render path). Flagged in the
 * proposal as the one place this page would benefit from a schema column.
 */
const COVER_HEIGHT = Math.round((COVER_WIDTH * 9) / 16);

/** SPEC-009: "og:description (first 160 chars of bodyText)". */
const OG_DESCRIPTION_LENGTH = 160;

interface PageProps {
  /** Next 15 hands dynamic params to a Server Component as a Promise. */
  params: Promise<{ slug: string }>;
}

function excerpt(bodyText: string): string {
  return bodyText.trim().replace(/\s+/g, ' ').slice(0, OG_DESCRIPTION_LENGTH);
}

/**
 * The `og:image` fallback, generated from local data.
 *
 * SPEC-009 requires an `og:image` that is *"cover or a generated fallback —
 * all from local data, no external calls"*. With no cover there is no file to
 * point at, and the two other ways to produce one are both out of reach:
 * an `/api/og` route handler would be a route SPEC-011's closed table does not
 * contain (and `tests/unit/route-map.test.ts` fails on any page or handler
 * outside it), and writing a PNG to disk at render time is a filesystem write
 * on a GET.
 *
 * So the card is drawn as an SVG data URL: deterministic, built from the
 * article's own title and author, no request, no file, no route. The honest
 * limitation is that most third-party scrapers will not fetch a `data:` URL —
 * which costs this product nothing, because it has no external network at all
 * (SPEC-001) and nothing off this machine can reach the page to scrape it.
 */
function fallbackOgImage(title: string, authorName: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // Wrapped by hand at roughly 30 characters a line: SVG has no text flow, so
  // a long title would otherwise run off the edge of the card.
  const words = escape(title).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length > 0 && `${line} ${word}`.length > 30) {
      lines.push(line);
      line = word;
    } else {
      line = line.length > 0 ? `${line} ${word}` : word;
    }
    if (lines.length === 3) break;
  }
  if (lines.length < 3 && line.length > 0) lines.push(line);

  const tspans = lines
    .map((text, index) => `<tspan x="80" dy="${index === 0 ? 0 : 76}">${text}</tspan>`)
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
    `<rect width="1200" height="630" fill="#ffffff"/>` +
    `<rect x="0" y="0" width="1200" height="8" fill="#1a8917"/>` +
    `<text x="80" y="240" font-family="Georgia, serif" font-size="64" font-weight="700" fill="#242424">${tspans}</text>` +
    `<text x="80" y="540" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#6b6b6b">${escape(authorName)} · Titan</text>` +
    `</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * SPEC-009: *"`generateMetadata` emits `<title>`, `og:title`, `og:description`
 * (first 160 chars of `bodyText`), and `og:image` (cover or a generated
 * fallback) — all from local data, no external calls."*
 *
 * An unknown slug returns bare metadata rather than throwing: the page's own
 * `notFound()` produces the 404, and a metadata function that threw would turn
 * "unknown slug" into a 500, which the routing criterion explicitly forbids.
 * A draft is treated the same way — the title of an unpublished article is not
 * public, and leaking it in a `<title>` would defeat the 404 below.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  const viewer = (await auth())?.user ?? null;

  if (!article || !canViewArticle(viewer, article)) return { title: 'Not found' };

  const author = await findUserById(article.authorId);
  const description = excerpt(article.bodyText);
  const image = article.coverPath ?? fallbackOgImage(article.title, author?.name ?? 'Titan');

  return {
    title: article.title,
    description,
    openGraph: {
      type: 'article',
      title: article.title,
      description,
      images: [image],
      ...(article.publishedAt ? { publishedTime: article.publishedAt.toISOString() } : {}),
    },
  };
}

const columnStyle: CSSProperties = {
  paddingBlock: 'var(--space-7)',
};

const footerStyle: CSSProperties = {
  marginBlockStart: 'var(--space-7)',
  fontFamily: 'var(--font-ui)',
};

export default async function ArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  const viewer = (await auth())?.user ?? null;

  // Unknown slug and unreadable draft are one answer, on purpose (SPEC-005).
  if (!article || !canViewArticle(viewer, article)) notFound();

  const author = await findUserById(article.authorId);
  // An article whose author row has gone is a broken join, not a 500 for the
  // reader: the cascade should make it impossible, and a 404 is the honest
  // answer if it ever is not.
  if (!author) notFound();

  const [tags, clap, bookmark, follow] = await Promise.all([
    listTagsForArticle(article.id),
    readClapState(viewer, article.id),
    readBookmarkState(viewer, article.id),
    readFollowState(viewer, author.id),
  ]);

  const signedIn = viewer !== null;

  return (
    <ClapProvider
      articleId={article.id}
      slug={article.slug}
      signedIn={signedIn}
      initialTotal={clap.total}
      initialMine={clap.mine}
      // The two clap constants are read HERE and handed down, because a client
      // component cannot import a value from `lib/engage/clap.ts` without
      // pulling `lib/db` — and therefore `node:crypto` — into the browser
      // bundle, which fails the webpack build outright. This page is on the
      // server side of that line, so it can read the module that owns the rule
      // and pass the numbers across. One definition, no duplicated literal.
      burstMs={CLAP_BURST_MS}
      maxClaps={MAX_CLAPS_PER_READER}
    >
      <BookmarkProvider
        articleId={article.id}
        slug={article.slug}
        signedIn={signedIn}
        initialBookmarked={bookmark.bookmarked}
      >
        <FollowProvider
          authorId={author.id}
          authorName={author.name}
          slug={article.slug}
          signedIn={signedIn}
          isSelf={viewer?.id === author.id}
          initialFollowing={follow.following}
          initialFollowerCount={follow.followerCount}
        >
          <ProgressBar targetId={BODY_ID} />
          <StickyBar title={article.title} headerId={HEADER_ID} />

          {/* Every page in this product renders its own `<main>` — `/`,
              `/bookmarks`, `/editor/[id]` and `app/not-found.tsx` all do, and
              the root layout deliberately does not, so the chrome stays outside
              it. Without one here axe reports `landmark-one-main` and `region`
              (content sitting outside any landmark), and a screen-reader user
              loses the skip target on the one page in the product that is
              mostly prose. */}
          <main data-testid="article-page">
            <div className="article-column" style={columnStyle}>
              <ArticleHeader
                id={HEADER_ID}
                title={article.title}
                subtitle={article.subtitle}
                author={{
                  name: author.name,
                  handle: author.handle,
                  avatarPath: author.avatarPath,
                }}
                publishedAt={article.publishedAt}
                readingMinutes={article.readingMinutes}
              />

              {article.coverPath ? (
                <figure
                  data-testid="article-cover"
                  style={{ margin: 'var(--space-6) 0', lineHeight: 0 }}
                >
                  <Image
                    src={article.coverPath}
                    alt=""
                    width={COVER_WIDTH}
                    height={COVER_HEIGHT}
                    // The cover is above the fold and is usually the LCP element,
                    // so it is preloaded rather than lazily fetched — the article
                    // LCP budget is 1.5s and a lazy hero spends most of it.
                    priority
                    sizes={`(max-width: ${COVER_WIDTH}px) 100vw, ${COVER_WIDTH}px`}
                    style={{
                      width: '100%',
                      height: 'auto',
                      maxWidth: `${COVER_WIDTH}px`,
                      objectFit: 'cover',
                      borderRadius: 'var(--radius-md)',
                    }}
                  />
                </figure>
              ) : null}
            </div>

            {/* `Prose` carries `--measure` itself and must NOT sit inside
                `.article-column`, or the measure and padding would be applied
                twice. The wrapper exists only to give `ProgressBar` an element
                to measure — a bare div adds no box of its own. */}
            <div id={BODY_ID}>
              <Prose as="article" sanitizedHtml={article.bodyHtml} />
            </div>

            <div className="article-column" style={footerStyle}>
              {tags.length > 0 ? (
                <ul
                  data-testid="article-tags"
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 'var(--space-2)',
                    listStyle: 'none',
                    margin: 'var(--space-6) 0',
                    padding: 0,
                  }}
                >
                  {tags.map((tag) => (
                    <li key={tag.id}>
                      <Tag href={tagHref(tag.slug)}>{tag.name}</Tag>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div
                data-testid="article-engagement"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  paddingBlock: 'var(--space-5)',
                  borderBlockStart: '1px solid var(--border)',
                }}
              >
                <ClapButton />
                <BookmarkButton />
              </div>

              <AuthorCard
                author={{
                  name: author.name,
                  handle: author.handle,
                  bio: author.bio,
                  avatarPath: author.avatarPath,
                }}
              />
            </div>
          </main>
        </FollowProvider>
      </BookmarkProvider>
    </ClapProvider>
  );
}
