/**
 * The closed route map, enforced against the filesystem (SPEC-011).
 *
 * > "No route outside this table exists in v1. A test enumerates the `app/`
 * >  directory and fails on any page file not listed here."
 *
 * ── What this suite is actually protecting ────────────────────────────────
 * An unlisted page file is a route a user can reach that nobody specified,
 * reviewed, or thought about the authorization of. Every other guard in this
 * project — the middleware's protected prefixes, `auth()`, the draft-privacy
 * rule — is written against a known set of surfaces. A route that appears
 * without passing through the spec is a route none of them were written for,
 * and it will be discovered by someone other than us.
 *
 * ── The direction of the check, and why it is one-way ─────────────────────
 * **page file → table**, not table → page file. This is recorded in DEC-020:
 * SPEC-011's table carries an `/api/auth/[...nextauth]` row that no file will
 * ever satisfy, because the project dropped Auth.js for the hand-rolled
 * argon2id + opaque database-session flow, and that row is a known editorial
 * defect in a LOCKED spec awaiting the operator's amendment batch. A
 * bidirectional assertion would fail on a row the decision already superseded
 * — which is why the criterion itself is phrased one-way: *"Every page file
 * under `app/` maps to exactly one route in the route-map table and no
 * unlisted page file exists."*
 *
 * The direction that is dropped is also the harmless one. A table row with no
 * file is a 404: a missing feature, which announces itself the first time
 * anybody clicks the link. A file with no table row is the dangerous case, and
 * it is the one asserted here.
 *
 * ── Why the mapper is unit-tested separately from the sweep ───────────────
 * The filesystem sweep can only be trusted if `routeForPageFile` is right, and
 * a subtly wrong mapper fails *open*: map everything to `/` and every page
 * file "matches" a real route, so the suite goes green while enforcing
 * nothing. The convention tests below pin the three App Router rules that
 * change a URL — route groups, private folders, the root — against inputs the
 * sweep may not currently contain.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { REPO_ROOT } from '../helpers/db';
import {
  BOOKMARKS,
  HOME,
  NEW_STORY,
  PAGE_ROUTES,
  ROUTES,
  SEARCH,
  SETTINGS_PROFILE,
  SIGN_IN,
  SIGN_UP,
  articleHref,
  draftsHref,
  editorHref,
  isKnownPageRoute,
  isPageFile,
  profileHref,
  routeFor,
  routeForPageFile,
  searchHref,
  signInHref,
  tagHref,
} from '../../lib/routes';

// ---------------------------------------------------------------------------
// The filesystem sweep
// ---------------------------------------------------------------------------

const IGNORED = new Set(['node_modules', '.next', '.git', 'coverage', 'data']);

/** Every file under `app/`, repo-relative, in POSIX form. */
function appFiles(): string[] {
  const out: string[] = [];
  const walk = (absolute: string) => {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry)) continue;
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) walk(child);
      else out.push(relative(REPO_ROOT, child).split(sep).join('/'));
    }
  };
  walk(join(REPO_ROOT, 'app'));
  return out.sort();
}

const ALL_APP_FILES = appFiles();
const PAGE_FILES = ALL_APP_FILES.filter(isPageFile);

describe('SPEC-011 — every page file under app/ is a route the spec names', () => {
  it('finds page files at all, so a broken walk cannot pass vacuously', () => {
    // Without this, a typo in the walk turns the headline assertion below into
    // `expect([]).toEqual([])` — the most comfortable kind of false green.
    expect(ALL_APP_FILES.length).toBeGreaterThan(3);
    expect(PAGE_FILES.length).toBeGreaterThan(0);
    // Two page files that exist today, named so the sweep is provably looking
    // at the real tree: one at the root, one inside a route group.
    expect(PAGE_FILES).toContain('app/page.tsx');
    expect(PAGE_FILES).toContain('app/(auth)/signin/page.tsx');
  });

  it('maps every page file to a route in the table', () => {
    const unlisted = PAGE_FILES.map((file) => ({ file, route: routeForPageFile(file) })).filter(
      ({ route }) => route === null || !isKnownPageRoute(route),
    );

    expect(
      unlisted.map(({ file, route }) => `${file} -> ${route ?? '(not routable)'}`),
      'These page files serve routes SPEC-011 does not list. The route map is a ' +
        'closed world: amend the spec (and lib/routes.ts with it) before adding a ' +
        'surface, or the route ships with no authorization rule written for it.',
    ).toEqual([]);
  });

  it('maps each page file to exactly one route — no two files serve the same URL', () => {
    // "maps to exactly one route" cuts both ways. Two files resolving to the
    // same URL is a build error in Next, but it is a *silent* one in a route
    // group ( `app/(a)/x/page.tsx` and `app/(b)/x/page.tsx` both serve `/x` ),
    // and it is the kind of thing a refactor introduces.
    const byRoute = new Map<string, string[]>();
    for (const file of PAGE_FILES) {
      const route = routeForPageFile(file);
      if (route === null) continue;
      byRoute.set(route, [...(byRoute.get(route) ?? []), file]);
    }
    const collisions = [...byRoute.entries()].filter(([, files]) => files.length > 1);
    expect(collisions).toEqual([]);
  });

  it('never counts a special file in the real tree as a page', () => {
    // Asserted against the actual filesystem, not a fixture list. `layout`,
    // `error`, `loading`, `not-found` and `template` are App Router special
    // files: they serve no URL of their own, so demanding a table row for one
    // would fail the sweep over a file that is not a route. Two layouts landed
    // under `app/` after this suite was written (DEC-029, DEC-030), which is
    // precisely the change that would have tripped it.
    const specials = ALL_APP_FILES.filter((file) =>
      /(^|\/)(layout|template|error|global-error|loading|not-found)\.(tsx|jsx|ts|js)$/.test(file),
    );
    expect(specials.length, 'no special files found — the walk is broken').toBeGreaterThan(3);
    expect(specials.filter(isPageFile)).toEqual([]);
    expect(specials.map(routeForPageFile).filter((route) => route !== null)).toEqual([]);
    // And the two this task owns are actually there, so the filter is not
    // passing because the files are missing.
    expect(specials).toContain('app/layout.tsx');
    expect(specials).toContain('app/(auth)/layout.tsx');
    expect(specials).toContain('app/not-found.tsx');
  });

  it('has no route handler outside the two the table names', () => {
    // `route.ts` files are routes too, and the same closed-world rule applies
    // to them — they just are not *pages*, so the sweep above cannot see them.
    const handlers = ALL_APP_FILES.filter((file) => /(^|\/)route\.(ts|tsx|js|jsx)$/.test(file));
    const allowed = new Set(
      ROUTES.filter((route) => route.kind === 'handler').map((route) => route.pattern),
    );
    const unlisted = handlers.filter((file) => {
      // `app/api/upload/route.ts` -> `/api/upload`
      const pattern = `/${file.split('/').slice(1, -1).join('/')}`;
      return !allowed.has(pattern);
    });
    expect(unlisted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe('SPEC-011 — the transcribed table', () => {
  it('lists every route the spec names, and nothing else', () => {
    // The table verbatim. Spelled out rather than derived, so a silent edit to
    // lib/routes.ts — the exact failure mode the closed world exists to
    // prevent — shows up here as a diff rather than as a passing test.
    expect(ROUTES.map((route) => route.pattern)).toEqual([
      '/',
      '/tag/[slug]',
      '/search',
      '/article/[slug]',
      '/editor/new',
      '/editor/[id]',
      '/@[handle]',
      '/settings/profile',
      '/signin',
      '/signup',
      '/bookmarks',
      '/api/upload',
      '/api/auth/[...nextauth]',
      '*',
    ]);
  });

  it('names each pattern exactly once', () => {
    expect(new Set(ROUTES.map((r) => r.pattern)).size).toBe(ROUTES.length);
  });

  it('assigns /bookmarks and the catch-all to App Shell, as the spec does', () => {
    // The two rows this slice owns. If either changes hands, this task's file
    // scope is wrong and someone should know.
    expect(routeFor(BOOKMARKS)?.owner).toBe('App Shell');
    expect(routeFor(BOOKMARKS)?.auth).toBe('signed-in');
    expect(routeFor('*')?.owner).toBe('App Shell');
    expect(routeFor('*')?.kind).toBe('not-found');
  });

  it('keeps /signin and /signup anonymous-only', () => {
    for (const pattern of [SIGN_IN, SIGN_UP]) {
      expect(routeFor(pattern)?.auth).toBe('anonymous');
    }
  });

  it('treats the superseded nextauth row as a handler with no file (DEC-020)', () => {
    const row = routeFor('/api/auth/[...nextauth]');
    expect(row?.kind).toBe('handler');
    // The point of the assertion: it is NOT a page route, so the filesystem
    // sweep never demands a file for it. That is what makes DEC-020 and the
    // locked table coexist without either being quietly amended.
    expect(isKnownPageRoute('/api/auth/[...nextauth]')).toBe(false);
  });

  it('exposes only page routes as page routes', () => {
    expect(PAGE_ROUTES.every((route) => route.kind === 'page')).toBe(true);
    expect(PAGE_ROUTES.map((r) => r.pattern)).not.toContain('*');
    expect(PAGE_ROUTES.map((r) => r.pattern)).not.toContain('/api/upload');
  });

  it('returns undefined for a route nobody specified', () => {
    expect(routeFor('/admin')).toBeUndefined();
    expect(isKnownPageRoute('/admin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The mapper's conventions
// ---------------------------------------------------------------------------

describe('SPEC-011 — app/ path to URL follows the App Router conventions', () => {
  it.each([
    ['app/page.tsx', '/'],
    ['app/bookmarks/page.tsx', '/bookmarks'],
    ['app/search/page.tsx', '/search'],
    ['app/settings/profile/page.tsx', '/settings/profile'],
    ['app/article/[slug]/page.tsx', '/article/[slug]'],
    ['app/editor/[id]/page.tsx', '/editor/[id]'],
    // Route groups contribute nothing to the URL. This is the convention that
    // makes a naive directory-join wrong, and the one the real tree uses.
    ['app/(auth)/signin/page.tsx', '/signin'],
    ['app/(auth)/signup/page.tsx', '/signup'],
    ['app/(marketing)/(inner)/about/page.tsx', '/about'],
    // Other page extensions route identically.
    ['app/search/page.jsx', '/search'],
    ['app/search/page.js', '/search'],
  ])('%s serves %s', (file, expected) => {
    expect(routeForPageFile(file)).toBe(expected);
  });

  it('treats a private folder as unroutable rather than as a URL', () => {
    // `_components` is excluded from routing by Next. Mapping it to a URL
    // would make this suite demand a spec row for a file that serves nothing.
    expect(routeForPageFile('app/_internal/page.tsx')).toBeNull();
    expect(routeForPageFile('app/feed/_scratch/page.tsx')).toBeNull();
  });

  it('ignores files that are not pages', () => {
    for (const file of [
      // Both layouts are named explicitly (DEC-029, DEC-030). They arrived
      // under `app/` *after* this enumeration was written, which is exactly
      // the shape of change that turns a passing route sweep into a failing
      // one for a file that serves no URL at all.
      'app/layout.tsx',
      'app/(auth)/layout.tsx',
      'app/error.tsx',
      'app/loading.tsx',
      'app/not-found.tsx',
      'app/globals.css',
      'app/bookmarks/actions.ts',
      'app/api/upload/route.ts',
      // A component that merely lives next to a page is not a page.
      'app/bookmarks/BookmarkRow.tsx',
      // Outside app/ entirely.
      'components/nav/page.tsx',
    ]) {
      expect(isPageFile(file), file).toBe(false);
      expect(routeForPageFile(file), file).toBeNull();
    }
  });

  it('keeps a leading @ as a literal segment, per the spec notation', () => {
    // SPEC-011 writes the profile route as `/@[handle]`, so the mapper has to
    // agree with the spec's own notation or the table can never match a file.
    // The hazard — Next reads a leading `@` as a parallel-route slot — is
    // documented at length in lib/routes.ts for whoever builds Profiles.
    expect(routeForPageFile('app/@[handle]/page.tsx')).toBe('/@[handle]');
    expect(isKnownPageRoute('/@[handle]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The href builders
// ---------------------------------------------------------------------------

/** Does a concrete URL match a bracketed route pattern? */
function matchesPattern(url: string, pattern: string): boolean {
  const path = url.split('?')[0] ?? '';
  const pathSegments = path.split('/');
  const patternSegments = pattern.split('/');
  if (pathSegments.length !== patternSegments.length) return false;
  return patternSegments.every((segment, index) => {
    const actual = pathSegments[index];
    if (actual === undefined) return false;
    // `[slug]` matches any single non-empty segment; `@[handle]` matches `@x`.
    if (segment === '[slug]' || segment === '[id]') return actual.length > 0;
    if (segment === '@[handle]') return actual.startsWith('@') && actual.length > 1;
    return segment === actual;
  });
}

describe('SPEC-011 — every href builder produces a route in the table', () => {
  it.each([
    ['home', HOME, '/'],
    ['search', SEARCH, '/search'],
    ['sign in', SIGN_IN, '/signin'],
    ['sign up', SIGN_UP, '/signup'],
    ['bookmarks', BOOKMARKS, '/bookmarks'],
    ['new story', NEW_STORY, '/editor/new'],
    ['settings', SETTINGS_PROFILE, '/settings/profile'],
  ])('the %s constant is the table row', (_name, value, expected) => {
    expect(value).toBe(expected);
    expect(isKnownPageRoute(value)).toBe(true);
  });

  it.each([
    [articleHref('why-we-read'), '/article/[slug]'],
    [tagHref('essays'), '/tag/[slug]'],
    [editorHref('cm5abc'), '/editor/[id]'],
    [editorHref(), '/editor/new'],
    [profileHref('grace'), '/@[handle]'],
    [draftsHref('grace'), '/@[handle]'],
    [searchHref('slow web'), '/search'],
    [searchHref('   '), '/search'],
    [signInHref('/bookmarks'), '/signin'],
    [signInHref(), '/signin'],
  ])('%s matches %s', (href, pattern) => {
    expect(matchesPattern(href, pattern), `${href} is not a ${pattern}`).toBe(true);
    expect(isKnownPageRoute(pattern)).toBe(true);
  });

  it('strips a leading @ the caller already added', () => {
    // Half the call sites hold a bare handle and half hold a display string.
    // `/@@grace` renders perfectly and 404s, which is the worst combination.
    expect(profileHref('@grace')).toBe('/@grace');
    expect(profileHref('grace')).toBe('/@grace');
    expect(profileHref('@@grace')).toBe('/@grace');
  });

  it('sends Drafts to the profile tab the spec names', () => {
    expect(draftsHref('grace')).toBe('/@grace?tab=drafts');
  });

  it('encodes a search query rather than interpolating it', () => {
    // Without encoding, `&` splits the query into a second parameter and `#`
    // truncates it — both reachable within the first ten searches anybody runs.
    expect(searchHref('tea & sympathy')).toBe('/search?q=tea%20%26%20sympathy');
    expect(searchHref('c#')).toBe('/search?q=c%23');
    expect(searchHref('  spaced  ')).toBe('/search?q=spaced');
    // An empty query is the bare route, not `?q=`.
    expect(searchHref('')).toBe('/search');
  });

  it('encodes the ?next= destination the middleware and the page share', () => {
    // The value `middleware.ts` writes and `safeNextPath` re-validates. The
    // encoding has to agree with `URLSearchParams.set`, which is what the
    // middleware uses — `tests/e2e/auth.spec.ts` asserts the literal
    // `/signin?next=%2Fbookmarks`.
    expect(signInHref('/bookmarks')).toBe('/signin?next=%2Fbookmarks');
    expect(signInHref('/settings/profile')).toBe('/signin?next=%2Fsettings%2Fprofile');
  });
});

// ---------------------------------------------------------------------------
// The wordmark
// ---------------------------------------------------------------------------

describe('SPEC-011 — the wordmark is original text, not an asset', () => {
  // The sealed criterion names tests/unit/originality.test.ts, which is
  // SPEC-003's file and outside this task's scope; it already asserts the
  // "no third-party logo asset in public/" half. The other half — "the
  // wordmark renders as the text `Titan`" — is asserted here at the source,
  // and again in the browser by tests/e2e/nav.spec.ts.
  const source = readFileSync(join(REPO_ROOT, 'components', 'nav', 'Wordmark.tsx'), 'utf8');

  it('renders the literal text Titan', () => {
    expect(source).toContain('Titan');
  });

  it('sets it in --font-reading, as the spec specifies', () => {
    expect(source).toContain('var(--font-reading)');
  });

  it('imports no image', () => {
    // An `<img>` or a `next/image` here would be the logo file the originality
    // rule forbids, arriving by the one route that test cannot see.
    expect(source).not.toMatch(/<img|next\/image|\.svg'|\.png'/);
  });
});
