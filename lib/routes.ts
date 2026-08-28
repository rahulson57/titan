/**
 * The closed route map (SPEC-011).
 *
 * > "No route outside this table exists in v1. A test enumerates the `app/`
 * >  directory and fails on any page file not listed here."
 *
 * That sentence is the reason this file is data rather than prose. A route map
 * kept only in a markdown table is a promise; a route map kept here is a
 * predicate `tests/unit/route-map.test.ts` can run against the filesystem, so
 * the first page file someone adds without amending the spec fails the gate
 * instead of quietly widening the product.
 *
 * ── Why every href in the app should come from here ────────────────────────
 * The second job of this module is to be the only place a route string is
 * spelled. Eight surfaces link to `/@handle`; if each writes the literal, then
 * renaming the route means finding eight of them and being sure there was no
 * ninth. `profileHref()` makes that a one-line change with a type error at any
 * site that got it wrong. It is also what keeps the map honest: a helper that
 * builds a path not in `ROUTES` is caught by this file's own tests.
 *
 * ── Direction of the enforcement, and why it is one-way ────────────────────
 * The check is **page file → table**, not table → page file. That asymmetry is
 * deliberate and it is recorded in DEC-020: SPEC-011's table carries a
 * `/api/auth/[...nextauth]` row that no file will ever satisfy, because the
 * project dropped Auth.js in favour of the hand-rolled argon2id + opaque
 * database-session flow, and the row is an editorial defect awaiting the
 * operator's spec-amendment batch. A bidirectional test would fail on a row
 * the decision already superseded.
 *
 * The one-way direction is also the one that carries the risk. An unlisted
 * page file is a route users can reach that nobody specified, reviewed or
 * threat-modelled — that is the failure worth catching. A listed route with no
 * file is a 404, which is merely a missing feature and announces itself.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * How a route is served, which decides what kind of file may satisfy it.
 *
 * Only `page` routes are matched against `app/**\/page.tsx`. Route handlers are
 * `route.ts` files and the catch-all is `not-found.tsx`; folding all three into
 * one list would make the file enumeration compare pages against routes that
 * can never be pages.
 */
export type RouteKind = 'page' | 'handler' | 'not-found';

/** SPEC-011's `Auth` column, verbatim. */
export type RouteAuth = 'public' | 'anonymous' | 'signed-in' | 'owner' | 'none';

export interface RouteEntry {
  /** The URL pattern, in Next's own bracket notation: `/article/[slug]`. */
  readonly pattern: string;
  /** SPEC-011's "Owner section" column — which slice owns the surface. */
  readonly owner: string;
  readonly auth: RouteAuth;
  readonly kind: RouteKind;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * SPEC-011's route table, transcribed row for row and in the same order.
 *
 * Keep this a transcription. If a route needs to change, the spec changes
 * first and this follows — the value of the table is that it is the same
 * closed world the specification describes, and a local edit here to make a
 * test pass would destroy exactly that.
 */
export const ROUTES: readonly RouteEntry[] = Object.freeze([
  { pattern: '/', owner: 'Feed & Search', auth: 'public', kind: 'page', notes: 'For you / Following tabs' },
  { pattern: '/tag/[slug]', owner: 'Feed & Search', auth: 'public', kind: 'page' },
  { pattern: '/search', owner: 'Feed & Search', auth: 'public', kind: 'page', notes: '?q=' },
  {
    pattern: '/article/[slug]',
    owner: 'Reading & Engagement',
    auth: 'public',
    kind: 'page',
    notes: 'DRAFT → 404 for non-author',
  },
  { pattern: '/editor/new', owner: 'Editor & Content', auth: 'owner', kind: 'page' },
  { pattern: '/editor/[id]', owner: 'Editor & Content', auth: 'owner', kind: 'page' },
  { pattern: '/@[handle]', owner: 'Profiles', auth: 'public', kind: 'page' },
  { pattern: '/settings/profile', owner: 'Profiles', auth: 'owner', kind: 'page' },
  {
    pattern: '/signin',
    owner: 'Identity & Auth',
    auth: 'anonymous',
    kind: 'page',
    notes: 'signed-in visitor → redirect /',
  },
  {
    pattern: '/signup',
    owner: 'Identity & Auth',
    auth: 'anonymous',
    kind: 'page',
    notes: 'signed-in visitor → redirect /',
  },
  {
    pattern: '/bookmarks',
    owner: 'App Shell',
    auth: 'signed-in',
    kind: 'page',
    notes: "reader's saved list",
  },
  { pattern: '/api/upload', owner: 'Media', auth: 'signed-in', kind: 'handler' },
  {
    pattern: '/api/auth/[...nextauth]',
    owner: 'Identity & Auth',
    auth: 'none',
    kind: 'handler',
    // DEC-020: superseded. The project implements the hand-rolled argon2id +
    // opaque database-session flow and does NOT create this file; the row is
    // an editorial defect in a LOCKED spec, held here so this table stays a
    // faithful transcription rather than a quiet local amendment. Nothing
    // asserts a file exists for it — see the module header on directionality.
    notes: 'superseded by DEC-020; no file exists for this row',
  },
  {
    pattern: '*',
    owner: 'App Shell',
    auth: 'public',
    kind: 'not-found',
    notes: 'app/not-found.tsx',
  },
]);

/** Just the routes a `page.tsx` may satisfy. */
export const PAGE_ROUTES: readonly RouteEntry[] = Object.freeze(
  ROUTES.filter((route) => route.kind === 'page'),
);

/** Every page pattern, as a set, for O(1) membership. */
const PAGE_PATTERNS = new Set(PAGE_ROUTES.map((route) => route.pattern));

/** Is this pattern one of the page routes SPEC-011 allows? */
export function isKnownPageRoute(pattern: string): boolean {
  return PAGE_PATTERNS.has(pattern);
}

/** The table row for a pattern, or `undefined` — routes are looked up, not assumed. */
export function routeFor(pattern: string): RouteEntry | undefined {
  return ROUTES.find((route) => route.pattern === pattern);
}

// ---------------------------------------------------------------------------
// app/ file path → route pattern
// ---------------------------------------------------------------------------

/** A repo-relative path that names an App Router page. */
const PAGE_FILE = /(^|\/)page\.(tsx|jsx|ts|js)$/;

export function isPageFile(repoRelativePath: string): boolean {
  return repoRelativePath.startsWith('app/') && PAGE_FILE.test(repoRelativePath);
}

/**
 * Translate `app/<segments>/page.tsx` into the URL it serves.
 *
 * Implements the three App Router conventions that change the URL, and no
 * more — a mapper that invented rules Next does not have would pass a test
 * while the product served something else:
 *
 *   - **Route groups** `(name)` contribute nothing to the path, so
 *     `app/(auth)/signin/page.tsx` is `/signin`. This is why the table has no
 *     `(auth)` in it, and why the mapper cannot just concatenate directories.
 *   - **Private folders** `_name` are excluded from routing entirely; a page
 *     inside one is not reachable, so it maps to `null` rather than to a URL
 *     that does not exist.
 *   - `app/page.tsx` is the root, `/`, not the empty string.
 *
 * ── The `@` hazard, flagged for whoever builds `/@[handle]` (TASK-010) ─────
 * SPEC-011 specifies the profile route as `/@[handle]`, and this mapper treats
 * a leading `@` as a literal path segment so that the spec's own notation
 * round-trips. Be aware that Next reads a folder beginning with `@` as a
 * **parallel-route slot**, not as a path segment — `app/@[handle]/page.tsx`
 * would very likely be interpreted as a slot named `[handle]` and would not
 * serve `/@someone` at all. Whoever owns Profiles has to pick a directory
 * shape that actually produces this URL (a catch-all or dynamic segment that
 * matches the `@` prefix is the usual answer) and, if that shape's directory
 * name differs from the URL, this mapper is where the equivalence belongs.
 * Raising it here rather than guessing: the profile route is not this slice's
 * to design, and a wrong guess baked into the enforcement test would block the
 * slice that is.
 *
 * Returns `null` when the path is not a routable page file.
 */
export function routeForPageFile(repoRelativePath: string): string | null {
  if (!isPageFile(repoRelativePath)) return null;

  const segments = repoRelativePath.split('/');
  // Drop the leading `app` and the trailing `page.tsx`; what remains is the URL.
  const between = segments.slice(1, -1);

  const path: string[] = [];
  for (const segment of between) {
    if (segment.startsWith('_')) return null; // private folder: not routable
    if (segment.startsWith('(') && segment.endsWith(')')) continue; // route group
    path.push(segment);
  }

  return path.length === 0 ? '/' : `/${path.join('/')}`;
}

// ---------------------------------------------------------------------------
// Href builders — the only place a route string is spelled
// ---------------------------------------------------------------------------

export const HOME = '/';
export const SEARCH = '/search';
export const SIGN_IN = '/signin';
export const SIGN_UP = '/signup';
export const BOOKMARKS = '/bookmarks';
export const NEW_STORY = '/editor/new';
export const SETTINGS_PROFILE = '/settings/profile';

/**
 * `/@handle`.
 *
 * A leading `@` in the argument is tolerated and stripped, because half the
 * call sites hold a bare handle and half hold a display string — and
 * `/@@grace` is the kind of defect that renders fine and 404s in production.
 */
export function profileHref(handle: string): string {
  return `/@${handle.replace(/^@+/, '')}`;
}

/** SPEC-011's avatar menu: `Drafts` is the profile page's drafts tab. */
export function draftsHref(handle: string): string {
  return `${profileHref(handle)}?tab=drafts`;
}

export function articleHref(slug: string): string {
  return `/article/${slug}`;
}

export function tagHref(slug: string): string {
  return `/tag/${slug}`;
}

export function editorHref(id?: string): string {
  return id ? `/editor/${id}` : NEW_STORY;
}

/**
 * `/search?q=...`.
 *
 * `encodeURIComponent` rather than raw interpolation: a query containing `&`
 * or `#` would otherwise be truncated or split into a second parameter, which
 * on a search box is a defect a user hits within the first ten queries.
 */
export function searchHref(query: string): string {
  const trimmed = query.trim();
  return trimmed ? `${SEARCH}?q=${encodeURIComponent(trimmed)}` : SEARCH;
}

/**
 * `/signin?next=<where they were going>`.
 *
 * The value is encoded here and re-validated by `safeNextPath` in
 * `lib/auth/config.ts` on the way back out — SPEC-005 owns that guard, and
 * this builder deliberately does not duplicate it. Two half-checks in two
 * files is how an open redirect gets shipped: each looks like the other one
 * is doing the work.
 */
export function signInHref(next?: string): string {
  return next ? `${SIGN_IN}?next=${encodeURIComponent(next)}` : SIGN_IN;
}
