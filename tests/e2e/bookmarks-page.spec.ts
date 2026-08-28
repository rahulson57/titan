/**
 * `/bookmarks` — the reader's saved library, in a real browser (SPEC-011).
 *
 * Two sealed criteria land here:
 *
 *   - "An anonymous request to `/bookmarks` redirects to `/signin?next=/bookmarks`."
 *   - "`/bookmarks` lists the signed-in user's bookmarks in `createdAt DESC`
 *      order, page size 20, and un-bookmarking removes the row from the list
 *      without a full page reload."
 *
 * ── Why the fixture is 25 bookmarks and not three ─────────────────────────
 * DEC-026 makes this a condition, and it is the difference between a test and
 * a decoration. A page-size-20 assertion seeded with three rows passes without
 * exercising pagination at all — the second page is empty either way. And
 * `createdAt DESC` is unfalsifiable unless insertion order and sort order can
 * actually disagree, so the fixture saves them in a deliberately scrambled
 * order with explicit, distinct timestamps. If the page ever fell back to
 * insertion order, primary-key order, or no order at all, this notices.
 *
 * The timestamps are injected rather than taken from a clock: `toggleBookmark`
 * accepts a `now`, so the fixture fixes the sort key instead of racing it.
 * Two bookmarks written in the same millisecond would otherwise tie, and a
 * cursor over a non-total order can repeat or drop rows — which is exactly the
 * failure `listBookmarkedArticles` breaks with `articleId DESC` as a tiebreak.
 *
 * ── Why "without a full page reload" is asserted with a window sentinel ───
 * A Server Action posts and patches the live document; a form that navigated
 * would tear the document down and take any `window` property with it. So the
 * test plants a value on `window`, un-bookmarks, and checks the value survived.
 * That observes the actual property the criterion names, rather than timing a
 * navigation event and hoping.
 *
 * ── On reading the development database ───────────────────────────────────
 * Same posture as `tests/e2e/auth.spec.ts`: the thing under test IS the dev
 * server, which has one database, and this suite observes it through `lib/db/`
 * — never by constructing a Prisma client of its own, which
 * `tests/unit/db-boundary.test.ts` forbids and which would run with
 * `foreign_keys` OFF, silently disabling the cascade this suite cleans up with.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { hashPassword } from '../../lib/auth/password';
import { disconnectDb } from '../../lib/db/client';
import { createArticle, publishArticle } from '../../lib/db/articles';
import { countBookmarks, toggleBookmark } from '../../lib/db/social';
import { createUser, deleteUser, findUserByEmail } from '../../lib/db/users';

/** SPEC-011 fixes the page size; the fixture must exceed it to mean anything. */
const PAGE_SIZE = 20;
const FIXTURE_SIZE = 25;

/** Long, unremarkable, and deliberately not on the 200-entry denylist. */
const PASSWORD = 'a quiet afternoon of reading';

let seq = 0;
function freshAccount(prefix: string) {
  const stamp = `${Date.now().toString(36)}${seq++}`;
  return {
    email: `${prefix}-${stamp}@titan.local`,
    password: PASSWORD,
    name: 'Bookmark Reader',
    handle: `${prefix}_${stamp}`.slice(0, 24),
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

/** A minimal but real ProseMirror document — `bodyText` is derived from it. */
function body(index: number) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              `Saved story number ${index}. ` +
              'It carries enough prose for the card to derive a reading time and an ' +
              'excerpt, so the row under test is the row a reader would actually see.',
          },
        ],
      },
    ],
  };
}

// A fixed instant, so the seeded order is a property of the fixture rather
// than of when the suite happened to run. Matches SPEC-002's determinism rule.
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

test.describe.configure({ mode: 'serial' });

test.describe('SPEC-011 — /bookmarks', () => {
  let readerId: string;
  let authorId: string;
  /** Article ids in the order they were SAVED — newest save last. */
  let savedOrder: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const account = freshAccount('bm');
    const page = await browser.newPage();
    await signUp(page, account);
    await page.close();

    const reader = await findUserByEmail(account.email);
    if (!reader) throw new Error('sign-up did not create the reader');
    readerId = reader.id;

    // A separate author, so the fixture exercises the byline join rather than
    // the degenerate case where reader and author are the same row.
    const authorAccount = freshAccount('bmauth');
    createdEmails.push(authorAccount.email);
    const author = await createUser({
      email: authorAccount.email,
      passwordHash: await hashPassword(authorAccount.password),
      handle: authorAccount.handle,
      name: 'Fixture Author',
      createdAt: EPOCH,
    });
    authorId = author.id;

    const articleIds: string[] = [];
    for (let index = 0; index < FIXTURE_SIZE; index += 1) {
      const title = `Bookmarked story ${String(index).padStart(2, '0')} ${Date.now().toString(36)}`;
      const article = await createArticle({
        authorId,
        title,
        bodyJson: body(index),
        bodyHtml: `<p>Saved story number ${index}.</p>`,
        status: 'PUBLISHED',
        now: new Date(EPOCH.getTime() + index * 60_000),
      });
      await publishArticle(article.id, new Date(EPOCH.getTime() + index * 60_000));
      articleIds.push(article.id);
    }

    // Save them in a SCRAMBLED order relative to creation, one minute apart.
    // If the page ever sorted by article date, primary key, or insertion, the
    // ordering assertion below would still pass on a sorted fixture — so the
    // fixture is deliberately not sorted.
    const scrambled = [...articleIds.keys()].sort((a, b) => ((a * 7) % 25) - ((b * 7) % 25));
    savedOrder = [];
    for (const [step, index] of scrambled.entries()) {
      const id = articleIds[index];
      if (!id) continue;
      await toggleBookmark(readerId, id, new Date(EPOCH.getTime() + step * 60_000));
      savedOrder.push(id);
    }

    expect(await countBookmarks(readerId)).toBe(FIXTURE_SIZE);
  });

  test.afterAll(async () => {
    // Cascade takes the articles, bookmarks and sessions with the users.
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('an anonymous request redirects to /signin?next=/bookmarks', async ({ browser }) => {
    // A fresh context: no cookie at all, which is the case middleware answers.
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/bookmarks');
    await expect(page).toHaveURL(/\/signin\?next=%2Fbookmarks/);
    // And the destination is actually usable — a redirect to a broken page
    // would satisfy the URL assertion and nothing a reader cares about.
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();

    await context.close();
  });

  test('a stale cookie is treated as anonymous, not as a session', async ({ browser }) => {
    // Middleware only sees that a cookie is PRESENT — it has no database on
    // the Edge runtime. This is the case it waves through, and it is the page's
    // own `auth()` check that has to catch it. Without that check a
    // hand-written cookie would be a login for this route.
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'titan.session',
        // Well-formed but naming no row: 32 bytes hex, exactly as real ones are.
        value: 'f'.repeat(64),
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();

    await page.goto('/bookmarks');
    await expect(page).toHaveURL(/\/signin\?next=%2Fbookmarks/);

    await context.close();
  });

  test('lists the reader’s bookmarks newest-save-first, 20 to a page', async ({ browser }) => {
    // A fresh context signed in as the FIXTURE reader — the one that owns the
    // 25 bookmarks. A newly signed-up account would have an empty library and
    // every assertion below would be vacuous.
    const { context, page } = await signInAsFixtureReader(browser);
    await page.goto('/bookmarks');

    const rows = page.getByTestId('bookmark-row');
    // "page size 20": exactly 20 of the 25 saved rows, not all of them.
    await expect(rows).toHaveCount(PAGE_SIZE);

    // `createdAt DESC`: the last thing saved is the first thing listed. The
    // fixture saved in a scrambled order, so this cannot pass by accident.
    const listed = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-article-id')),
    );
    const expected = [...savedOrder].reverse().slice(0, PAGE_SIZE);
    expect(listed).toEqual(expected);

    // And the timestamps are genuinely descending, read off the rendered
    // `<time>` rather than inferred from the id order above.
    const savedAt = await page
      .getByTestId('bookmark-saved-at')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime') ?? ''));
    const sorted = [...savedAt].sort().reverse();
    expect(savedAt).toEqual(sorted);

    // The remaining 5 are reachable, and the cursor does not repeat the last
    // row of page one — the defect `skip: 1` exists to prevent.
    await page.getByTestId('bookmarks-next').click();
    await expect(page.getByTestId('bookmark-row')).toHaveCount(FIXTURE_SIZE - PAGE_SIZE);
    const secondPage = await page
      .getByTestId('bookmark-row')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-article-id')));
    expect(secondPage.filter((id) => listed.includes(id))).toEqual([]);

    await context.close();
  });

  test('un-bookmarking removes the row without a full page reload', async ({ browser }) => {
    const { context, page } = await signInAsFixtureReader(browser);
    await page.goto('/bookmarks');

    const before = await page.getByTestId('bookmark-row').count();
    const firstId = await page
      .getByTestId('bookmark-row')
      .first()
      .getAttribute('data-article-id');

    // The sentinel. A navigation would destroy the document and take this with
    // it; a Server Action patches the live one and leaves it standing.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__titanNoReload = 'alive';
    });

    await page.getByTestId('bookmark-remove').first().click();

    // The row is gone from the list...
    await expect(page.locator(`[data-article-id="${firstId}"]`)).toHaveCount(0);
    // ...and the next page's row has moved up to fill it, so the count holds
    // rather than simply dropping — which is what cursor pagination should do.
    await expect(page.getByTestId('bookmark-row')).toHaveCount(before);

    // ...and the document was never torn down.
    const sentinel = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__titanNoReload,
    );
    expect(sentinel, 'the page reloaded — the un-bookmark control navigated').toBe('alive');

    // The removal is real, not optimistic: the row is gone from the database.
    expect(await countBookmarks(readerId)).toBe(FIXTURE_SIZE - 1);
  });

  test('shows the empty state once nothing is saved', async ({ browser }) => {
    // Clear the library through the repository rather than by clicking 24
    // times — the click path is already proven above, and this test is about
    // what the page renders at zero.
    const remaining = await countBookmarks(readerId);
    expect(remaining).toBeGreaterThan(0);
    for (const id of savedOrder) {
      // `toggleBookmark` is idempotent in the sense that it returns the
      // resulting state; calling it on a row already removed would re-create
      // it, so removal goes through the explicit path.
      const { removeBookmark } = await import('../../lib/db/social');
      await removeBookmark(readerId, id);
    }
    expect(await countBookmarks(readerId)).toBe(0);

    const { context, page } = await signInAsFixtureReader(browser);
    await page.goto('/bookmarks');

    // SPEC-011 fixes this string: "Empty state: 'Nothing saved yet' + link to `/`".
    await expect(page.getByTestId('empty-state')).toContainText('Nothing saved yet');
    await expect(page.getByTestId('bookmarks-empty-home')).toHaveAttribute('href', '/');
    await expect(page.getByTestId('bookmark-row')).toHaveCount(0);
    await expect(page.getByTestId('bookmarks-next')).toHaveCount(0);

    await context.close();
  });

  /** The fixture reader's email — the first account this suite created. */
  function fixtureEmail(): string {
    const email = createdEmails[0];
    if (!email) throw new Error('fixture reader was never created');
    return email;
  }

  /**
   * A fresh browser context signed in as the reader who owns the fixture.
   *
   * Each test gets its own context rather than sharing one, so a test cannot
   * inherit another's scroll position, cookies or open menu — SPEC-002 forbids
   * a flaky pass, and shared browser state is the usual source of one.
   */
  async function signInAsFixtureReader(browser: Browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/signin');
    await page.getByLabel('Email').fill(fixtureEmail());
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL('/');
    return { context, page };
  }
});
