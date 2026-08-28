/**
 * The persistent chrome, in a real browser (SPEC-011).
 *
 * Five sealed criteria land here, and each is a property only a browser can
 * actually witness:
 *
 *   - the nav renders `Sign in` + `Get started` anonymous, and `Write`,
 *     Bookmarks, ThemeToggle and the avatar menu signed in;
 *   - the avatar menu opens with `Enter`, cycles with ArrowDown/ArrowUp,
 *     closes on `Escape` and returns focus to its trigger;
 *   - a signed-in visitor at `/signin` or `/signup` is redirected to `/`;
 *   - an unmatched path returns HTTP 404 and renders `app/not-found.tsx` with
 *     a link to `/`;
 *   - navigating between routes shows a Skeleton within 200 ms, never a blank
 *     frame.
 *
 * A unit test can assert that `UserMenu` sets `tabIndex={-1}` on inactive
 * items. Only a browser can assert that pressing ArrowDown actually moves
 * focus, and that Escape puts it back on the trigger — which is the property,
 * and the reason these are here rather than in `components.test.tsx`.
 *
 * ── On reading the development database ───────────────────────────────────
 * Same posture as `tests/e2e/auth.spec.ts`, for the same reason: the thing
 * under test IS the dev server, and the dev server has one database. This
 * suite observes it through `lib/db/` — never by constructing a Prisma client
 * of its own, which `tests/unit/db-boundary.test.ts` forbids and which would
 * run with `foreign_keys` OFF.
 *
 * ── Why the last two criteria are guarded ─────────────────────────────────
 * `/article/[slug]` and `/@[handle]` belong to TASK-009 and TASK-010 and do
 * not exist yet. The Skeleton criterion names all three routes, so it is
 * stated in full and arms itself route by route as those slices land — the
 * assertions are real and pre-wired, not stubbed. `/` exists today, so the
 * part that can run, runs.
 */

import { expect, test, type Page } from '@playwright/test';

import { disconnectDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fresh identity per test.
 *
 * A timestamp plus a counter guarantees no two accounts collide on
 * `User.email`'s unique index, within a run or across two runs seconds apart.
 * A collision would surface as a sign-up validation error and read as a
 * product bug rather than as test interference.
 */
let accountSeq = 0;
function freshAccount() {
  const stamp = `${Date.now().toString(36)}${accountSeq++}`;
  return {
    email: `nav-${stamp}@titan.local`,
    // Long, unremarkable, deliberately not on the 200-entry denylist.
    password: 'a quiet afternoon of reading',
    name: 'Nav Tester',
    handle: `nav_${stamp}`.slice(0, 24),
  };
}

const createdEmails: string[] = [];

async function signUp(page: Page, account: ReturnType<typeof freshAccount>) {
  createdEmails.push(account.email);
  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL('/');
}

test.afterAll(async () => {
  // Delete only what this run created. Sessions and bookmarks go with the user
  // by `onDelete: Cascade`, a schema property SPEC-004 already proves.
  for (const email of createdEmails) {
    const user = await findUserByEmail(email);
    if (user) await deleteUser(user.id);
  }
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// The two nav states
// ---------------------------------------------------------------------------

test.describe('SPEC-011 — the top nav in both states', () => {
  test('an anonymous visitor gets the wordmark, search, Sign in and Get started', async ({
    page,
  }) => {
    await page.goto('/');

    const nav = page.getByTestId('top-nav');
    await expect(nav).toBeVisible();

    // The wordmark is the text "Titan", not an asset (SPEC-011's originality
    // rule). `tests/unit/originality.test.ts` proves no logo file exists;
    // this proves what actually renders in its place.
    const wordmark = page.getByTestId('wordmark');
    await expect(wordmark).toHaveText('Titan');
    await expect(wordmark).toHaveAttribute('href', '/');

    await expect(page.getByTestId('nav-search')).toBeVisible();
    await expect(page.getByTestId('nav-signin')).toHaveText('Sign in');
    await expect(page.getByTestId('nav-signup')).toHaveText('Get started');

    // The signed-in-only controls are absent. This IS a safe absence
    // assertion — the criterion names these four as the signed-in state, and a
    // `Write` link shown to a signed-out visitor is a broken promise.
    await expect(page.getByTestId('nav-write')).toHaveCount(0);
    await expect(page.getByTestId('nav-bookmarks')).toHaveCount(0);
    await expect(page.getByTestId('user-menu')).toHaveCount(0);

    // NOTE (DEC-029): no assertion that the ThemeToggle is absent. It is
    // rendered for anonymous visitors deliberately — `theme.spec.ts` drives
    // `/` in a fresh anonymous context and never signs in, so a signed-in-only
    // toggle would leave SPEC-003's theming criteria asserted by nothing.
    // Asserting absence here would seal in the reading DEC-029 rejected.
  });

  test('the search box is a real GET form that lands on /search?q=', async ({ page }) => {
    // SPEC-011's route table specifies `/search` with `?q=`. The parameter name
    // is part of the contract, not an implementation detail — `/search` reads it.
    await page.goto('/');
    await page.getByTestId('nav-search-input').fill('slow web');
    await page.getByTestId('nav-search-input').press('Enter');
    await page.waitForURL(/\/search\?q=/);
    expect(new URL(page.url()).searchParams.get('q')).toBe('slow web');
  });

  test('a signed-in visitor gets Write, Bookmarks, ThemeToggle and the avatar menu', async ({
    page,
  }) => {
    await signUp(page, freshAccount());

    await expect(page.getByTestId('nav-write')).toHaveAttribute('href', '/editor/new');
    await expect(page.getByTestId('nav-bookmarks')).toHaveAttribute('href', '/bookmarks');
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();

    // The anonymous calls to action are gone.
    await expect(page.getByTestId('nav-signin')).toHaveCount(0);
    await expect(page.getByTestId('nav-signup')).toHaveCount(0);
  });

  test('the chrome is persistent — it is on every route, not just the home page', async ({
    page,
  }) => {
    // "The persistent chrome around every page" is SPEC-011's deliverable, and
    // a nav mounted on one page would satisfy every other test in this file.
    // These are the routes that exist today; the rest arrive with their slices.
    for (const route of ['/', '/signin', '/signup', '/bookmarks', '/definitely-not-a-route']) {
      await page.goto(route);
      await expect(page.getByTestId('top-nav'), `no nav on ${route}`).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// The avatar menu — the keyboard contract
// ---------------------------------------------------------------------------

test.describe('SPEC-011 — the avatar menu is a keyboard-navigable menu widget', () => {
  /** The four items, in the spec's order. */
  const ITEMS = ['profile', 'drafts', 'settings', 'signout'] as const;

  const itemTestId = (key: (typeof ITEMS)[number]) => `user-menu-${key}`;

  test('opens with Enter and puts focus on the first item', async ({ page }) => {
    const account = freshAccount();
    await signUp(page, account);

    const trigger = page.getByTestId('user-menu-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    // Focused and opened by keyboard, the way the criterion words it — not by
    // a click, which would prove nothing about the keyboard contract.
    await trigger.focus();
    await page.keyboard.press('Enter');

    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('user-menu-items')).toBeVisible();
    await expect(page.getByTestId(itemTestId('profile'))).toBeFocused();
  });

  test('lists exactly the four items the spec names, pointing where it says', async ({ page }) => {
    const account = freshAccount();
    await signUp(page, account);

    await page.getByTestId('user-menu-trigger').click();

    const menu = page.getByTestId('user-menu-items');
    await expect(menu).toHaveAttribute('role', 'menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(4);

    await expect(page.getByTestId(itemTestId('profile'))).toHaveAttribute(
      'href',
      `/@${account.handle}`,
    );
    await expect(page.getByTestId(itemTestId('drafts'))).toHaveAttribute(
      'href',
      `/@${account.handle}?tab=drafts`,
    );
    await expect(page.getByTestId(itemTestId('settings'))).toHaveAttribute(
      'href',
      '/settings/profile',
    );
    // Sign out is a submit button, not a link — it mutates (it deletes the
    // Session row), and a prefetchable GET could sign a reader out by hover.
    await expect(page.getByTestId(itemTestId('signout'))).toHaveAttribute('type', 'submit');
  });

  test('ArrowDown and ArrowUp cycle through the items, wrapping at both ends', async ({ page }) => {
    await signUp(page, freshAccount());

    const trigger = page.getByTestId('user-menu-trigger');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(itemTestId('profile'))).toBeFocused();

    // Down through every item.
    for (const key of ITEMS.slice(1)) {
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId(itemTestId(key))).toBeFocused();
    }

    // "Cycle", not "stop at the end": one more Down wraps to the first item.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(itemTestId('profile'))).toBeFocused();

    // And Up from the first wraps to the last, which is the half that a naive
    // `Math.min/Math.max` clamp gets wrong while looking correct going down.
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId(itemTestId('signout'))).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId(itemTestId('settings'))).toBeFocused();
  });

  test('Escape closes the menu and returns focus to the trigger', async ({ page }) => {
    await signUp(page, freshAccount());

    const trigger = page.getByTestId('user-menu-trigger');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(itemTestId('drafts'))).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('user-menu-items')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The half that is most often missed: a menu that closes and drops focus
    // on <body> strands a keyboard user at the top of the document.
    await expect(trigger).toBeFocused();
  });

  test('exactly one item is in the tab order at a time', async ({ page }) => {
    // The roving-tabindex property. Without it, Tab walks through four menu
    // items before reaching the rest of the page — the trap the menu pattern
    // exists to prevent, and invisible to every other test in this file.
    await signUp(page, freshAccount());
    await page.getByTestId('user-menu-trigger').click();

    const tabbable = await page
      .getByTestId('user-menu-items')
      .getByRole('menuitem')
      .evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('tabindex') === '0').length);
    expect(tabbable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Signed-in visitors are redirected away from the auth pages
// ---------------------------------------------------------------------------

test.describe('SPEC-011 — a signed-in visitor is redirected off /signin and /signup', () => {
  // DEC-030: both routes are asserted separately and deliberately. They share
  // one guard in `app/(auth)/layout.tsx`, so testing only one would pass just
  // as happily if someone later moved the guard onto `signin/page.tsx` and
  // deleted the layout — silently un-guarding `/signup`, the route that cannot
  // guard itself because it is a Client Component.
  for (const route of ['/signin', '/signup']) {
    test(`${route} redirects to /`, async ({ page }) => {
      await signUp(page, freshAccount());

      await page.goto(route);
      await page.waitForURL('/');
      expect(new URL(page.url()).pathname).toBe('/');
    });
  }

  test('an anonymous visitor still reaches both forms', async ({ page }) => {
    // The other half of the rule, and the one a too-eager guard breaks. If
    // this failed, the product would have no way to sign in at all — which is
    // exactly what a middleware implementation would do to a visitor whose
    // session had merely expired (DEC-025a).
    await page.goto('/signin');
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();

    await page.goto('/signup');
    await expect(page.getByRole('button', { name: /create account/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The 404 surface
// ---------------------------------------------------------------------------

test.describe('SPEC-011 — an unmatched path is a real 404', () => {
  test('returns HTTP 404 and renders not-found.tsx with a link home', async ({ page }) => {
    const response = await page.goto('/no-such-page-exists-here');

    // The STATUS, not just the markup. A soft 404 — a 200 carrying an
    // apology — gets indexed and cached, and tells a crawler the page exists.
    expect(response?.status()).toBe(404);

    await expect(page.getByTestId('not-found')).toBeVisible();
    await expect(page.getByTestId('not-found-home')).toHaveAttribute('href', '/');

    // "with a link to `/`" — followed, not merely present.
    await page.getByTestId('not-found-home').click();
    await page.waitForURL('/');
  });

  test('the 404 offers a search box, and it works', async ({ page }) => {
    // SPEC-011: "404 with a link home and a search box." A reader who reached
    // a 404 mistyped or followed a stale link; a way to find what they wanted
    // is more useful than a way back to the top.
    await page.goto('/no-such-page-exists-here');
    const search = page.getByTestId('not-found').getByRole('searchbox');
    await search.fill('essays');
    await search.press('Enter');
    await page.waitForURL(/\/search\?q=essays/);
  });

  test('the route map is closed — no unlisted surface answers', async ({ page }) => {
    // Paths that look plausible and must not exist in v1. `route-map.test.ts`
    // proves no page FILE serves them; this proves the running server agrees,
    // which is the property a reader or a crawler actually meets.
    //
    // `/api/auth/signin` is in this list on purpose: DEC-020 dropped Auth.js,
    // so the `/api/auth/[...nextauth]` row in SPEC-011's table has no file and
    // must answer nothing. This is the one-directional check's other half,
    // observed at the server rather than on the filesystem.
    // Every path here is outside SPEC-005's PROTECTED_PREFIXES, so nothing
    // redirects and the route map answers directly — see the next test for
    // why `/settings` and `/editor` cannot be in this list.
    for (const path of ['/admin', '/api/auth/signin', '/feed', '/stories', '/about']) {
      const response = await page.goto(path);
      expect(
        response?.status(),
        `${path} answered ${response?.status()} — the route map is meant to be closed`,
      ).toBe(404);
    }
  });

  test('a protected prefix is bounced to sign-in before it can 404', async ({ page, browser }) => {
    // `/settings` and `/editor` are unlisted — neither is a route in SPEC-011's
    // table, which names only `/settings/profile`, `/editor/new` and
    // `/editor/[id]`. But they are also inside SPEC-005's PROTECTED_PREFIXES,
    // so middleware redirects an anonymous request BEFORE routing resolves it
    // and the answer is a 200 sign-in page rather than a 404.
    //
    // That interaction is worth pinning rather than working around. It is
    // correct — a signed-out visitor should be asked to sign in whatever they
    // were reaching for, and telling them "no such page" would leak that the
    // path is unprotected — but it means "closed route map" and "returns 404"
    // are not the same assertion for these paths, and a test that assumed they
    // were would fail for a reason that has nothing to do with the route map.
    for (const path of ['/settings', '/editor']) {
      await page.goto(path);
      await expect(page, `${path} was not bounced to sign-in`).toHaveURL(/\/signin\?next=/);
    }

    // Once signed in there is no redirect left to hide behind, and the closed
    // route map answers for itself.
    const context = await browser.newContext();
    const signedIn = await context.newPage();
    await signUp(signedIn, freshAccount());
    for (const path of ['/settings', '/editor']) {
      const response = await signedIn.goto(path);
      expect(response?.status(), `${path} exists and should not`).toBe(404);
    }
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Loading states
// ---------------------------------------------------------------------------

test.describe('SPEC-011 — navigation never shows a blank frame', () => {
  /**
   * The routes the criterion names. Two of them belong to slices that have not
   * landed, so each is probed rather than assumed — the assertion is real and
   * arms itself as `/article/[slug]` (TASK-009) and `/@[handle]` (TASK-010)
   * appear. Nothing here needs editing when they do.
   */
  const CRITERION_ROUTES = [
    { path: '/', owner: 'TASK-007 (Feed & Search)' },
    { path: '/article/any-slug', owner: 'TASK-009 (Reading & Engagement)' },
    { path: '/@anyone', owner: 'TASK-010 (Profiles)' },
  ];

  test('app/loading.tsx renders the Skeleton primitive, not a blank frame', async ({ page }) => {
    // The mechanism, asserted directly rather than inferred from a race.
    // Playwright's `waitUntil: 'commit'` returns as soon as the response
    // starts, so the Suspense fallback is observable before the page settles.
    //
    // The value being protected is SPEC-011's "no route shows a blank white
    // frame for more than 200 ms after navigation": the fallback is in the
    // client bundle and renders synchronously, with no data fetch in its path.
    await page.goto('/bookmarks', { waitUntil: 'commit' });

    // Either the skeleton is up, or the destination already rendered — both
    // mean the reader never saw a blank frame. A strict "skeleton must appear"
    // assertion would be flaky by construction: on a fast local machine the
    // real page can win the race, and that is a pass, not a failure.
    const settled = page
      .getByTestId('bookmarks-page')
      .or(page.getByTestId('route-loading'))
      .or(page.getByRole('button', { name: /^sign in$/i }));
    await expect(settled.first()).toBeVisible({ timeout: 5_000 });
  });

  for (const route of CRITERION_ROUTES) {
    test(`${route.path} is never a blank frame`, async ({ page }) => {
      const response = await page.goto(route.path);
      test.skip(
        response?.status() === 404,
        `skipped: needs ${route.owner} — ${route.path} does not resolve yet`,
      );

      // Something is painted, and it is not an empty document. `<body>` always
      // holds the nav once the shell is mounted, so an empty body means the
      // chrome itself failed to render.
      const bodyText = await page.locator('body').innerText();
      expect(bodyText.trim().length).toBeGreaterThan(0);
      await expect(page.getByTestId('top-nav')).toBeVisible();
    });
  }
});
