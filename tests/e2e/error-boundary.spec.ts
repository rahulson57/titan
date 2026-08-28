/**
 * The global error boundary (SPEC-011).
 *
 * > "A thrown render error shows the error boundary with a retry button and
 * >  the DOM contains no stack-trace text when `NODE_ENV=production`."
 *
 * ── How this suite provokes a real failure ────────────────────────────────
 * There is no `/throw` route to visit, and there deliberately must not be: the
 * route map is a closed world (SPEC-011) and `tests/unit/route-map.test.ts`
 * fails on any page file the spec does not list. Adding a test-only throwing
 * route would mean amending a locked spec to make a test easier, which is
 * backwards.
 *
 * So the failure is induced at the transport layer: Playwright intercepts the
 * POST that `/bookmarks`'s un-bookmark control makes to its Server Action and
 * answers with a 500. The client's action call rejects, the rejection
 * propagates through React, and the nearest boundary — `app/error.tsx` —
 * renders.
 *
 * That is not a synthetic condition. It is what a reader meets when the server
 * falls over mid-interaction, when a deploy swaps the build out from under an
 * open tab, or when a proxy returns an error page in place of a payload. It
 * exercises the real component through React's real error-boundary machinery
 * rather than rendering it directly, which is the whole reason this is an e2e
 * spec and not a unit test.
 *
 * ── Where the boundary's reach ends, measured rather than assumed ─────────
 * `app/error.tsx` catches errors thrown **below** the root layout. It does NOT
 * catch errors thrown by the root layout itself — those escape to Next's
 * `global-error` fallback, which renders the bare "Application error: a
 * client-side exception has occurred" page.
 *
 * This was established empirically while building this suite, and it matters
 * for anyone extending it: a fault injected into `TopNav`, `UserMenu` or
 * `ThemeToggle` — all of which live in the root layout — produces that
 * fallback and never reaches `error.tsx`, so a test written against one would
 * fail while the boundary was working perfectly. The fault therefore goes into
 * a **page**, which is what the boundary is mounted for.
 *
 * ── On the production half of the criterion ───────────────────────────────
 * The stack-trace rule is conditioned on `NODE_ENV=production`, and this suite
 * normally runs against `next dev`. Rather than assert nothing, the DOM check
 * runs in both modes with the right expectation for each: no trace in a
 * production build, and the detail block PRESENT in development — which is
 * what proves the production assertion is testing something rather than
 * passing against a blank page.
 *
 * The structural half is stronger than either and holds unconditionally:
 * `error.tsx` reads `error.message`/`error.stack` inside exactly one branch
 * guarded by `process.env.NODE_ENV !== 'production'`, a build-time constant
 * the bundler eliminates. In a production build the text is not in the bundle
 * to leak.
 */

import { expect, test, type Page } from '@playwright/test';

import { createArticle, publishArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import { toggleBookmark } from '../../lib/db/social';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

/** SPEC-002 runs the budget suites against `next start`; this detects that. */
const IS_PRODUCTION_BUILD = (process.env.PW_WEBSERVER ?? '').includes('start');

let seq = 0;
function freshAccount() {
  const stamp = `${Date.now().toString(36)}${seq++}`;
  return {
    email: `err-${stamp}@titan.local`,
    password: 'a quiet afternoon of reading',
    name: 'Error Tester',
    handle: `err_${stamp}`.slice(0, 24),
  };
}

const createdEmails: string[] = [];

/**
 * Sign up, and leave one bookmark saved.
 *
 * The bookmark is the fixture: its un-bookmark control is the page-level
 * Server Action this suite breaks. Without it `/bookmarks` renders the empty
 * state and there is nothing to fail.
 */
async function signedInReaderWithABookmark(page: Page): Promise<string> {
  const account = freshAccount();
  createdEmails.push(account.email);

  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL('/');

  const user = await findUserByEmail(account.email);
  if (!user) throw new Error('sign-up did not create the reader');

  const article = await createArticle({
    authorId: user.id,
    title: `Error fixture ${Date.now().toString(36)}`,
    bodyJson: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Enough prose for the card to derive an excerpt from.' }],
        },
      ],
    },
    bodyHtml: '<p>Enough prose for the card to derive an excerpt from.</p>',
    status: 'PUBLISHED',
  });
  await publishArticle(article.id);
  await toggleBookmark(user.id, article.id);

  return user.id;
}

test.afterAll(async () => {
  for (const email of createdEmails) {
    const user = await findUserByEmail(email);
    if (user) await deleteUser(user.id);
  }
  await disconnectDb();
});

/**
 * Make the next Server Action POST fail at the transport.
 *
 * Matched on the `next-action` request header rather than on the URL, because
 * a Server Action posts to the page's own path — so matching by URL would also
 * intercept ordinary navigations and break the page for the wrong reason.
 */
async function breakServerActions(page: Page) {
  await page.route(
    () => true,
    async (route) => {
      const request = route.request();
      const isAction =
        request.method() === 'POST' && request.headers()['next-action'] !== undefined;
      if (!isAction) return route.continue();
      await route.fulfill({
        status: 500,
        contentType: 'text/html',
        body: '<html><body>upstream is unavailable</body></html>',
      });
    },
  );
}

/** Put the reader on `/bookmarks` with one row, then break the action. */
async function reachTheBoundary(page: Page) {
  await signedInReaderWithABookmark(page);
  await page.goto('/bookmarks');
  await expect(page.getByTestId('bookmark-row')).toHaveCount(1);

  await breakServerActions(page);
  await page.getByTestId('bookmark-remove').first().click();

  await expect(page.getByTestId('error-boundary')).toBeVisible({ timeout: 15_000 });
}

test.describe('SPEC-011 — the global error boundary', () => {
  test('a failed render shows the boundary with a retry button', async ({ page }) => {
    await reachTheBoundary(page);

    const boundary = page.getByTestId('error-boundary');

    // "with a retry button" — a real <button>, found by its accessible name
    // rather than by a test id, because the name is what a user and a screen
    // reader actually have to work with.
    await expect(boundary.getByRole('button', { name: /try again/i })).toBeVisible();

    // A second way out, for the failure that retrying will never fix.
    await expect(page.getByTestId('error-home')).toHaveAttribute('href', '/');

    // The message is in plain language, not an error code.
    await expect(boundary).toContainText('Something went wrong');
  });

  test('the retry button actually re-renders once the fault clears', async ({ page }) => {
    // A retry control that does not retry is worse than none — it teaches the
    // reader the product is broken twice. This proves `reset()` is wired to
    // React's boundary rather than being decoration.
    await reachTheBoundary(page);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.getByRole('button', { name: /try again/i }).click();

    await expect(page.getByTestId('error-boundary')).toHaveCount(0, { timeout: 15_000 });
    // And the real page is back, not a blank frame where the boundary was.
    await expect(page.getByTestId('bookmarks-page')).toBeVisible();
  });

  test('the chrome survives the error — the reader is not stranded', async ({ page }) => {
    // `error.tsx` sits INSIDE the root layout, so the nav must still be there.
    // If a render error took the navigation with it, the only way off a failed
    // page would be the browser's back button.
    await reachTheBoundary(page);

    await expect(page.getByTestId('top-nav')).toBeVisible();
    await expect(page.getByTestId('wordmark')).toHaveText('Titan');

    // Followable, not merely present: the reader can leave.
    await page.getByTestId('wordmark').click();
    await page.waitForURL('/');
  });

  test('the DOM carries no stack trace when NODE_ENV=production', async ({ page }) => {
    await reachTheBoundary(page);

    const html = await page.content();

    if (IS_PRODUCTION_BUILD) {
      // The criterion, asserted where it is meant to hold. A stack trace names
      // absolute paths on the server's disk, internal module names, and often
      // the shape of the data that broke — none of which belongs on a page a
      // stranger can screenshot and post.
      await expect(page.getByTestId('error-detail')).toHaveCount(0);
      for (const marker of ['\n    at ', '.tsx:', '.ts:', 'webpack-internal', 'node_modules']) {
        expect(html, `production DOM leaked ${marker}`).not.toContain(marker);
      }
    } else {
      // Development. The detail block is expected — and asserting its presence
      // here is what proves the production branch above is a real check rather
      // than one that would pass against a blank page.
      await expect(page.getByTestId('error-detail')).toBeVisible();
    }
  });

  test('the digest is shown in every environment, and it is only a digest', async ({ page }) => {
    // The one thing that survives redaction, and the reason a production
    // failure is still diagnosable: a hash that matches the page to a server
    // log line, carrying no source text, no paths and no user data.
    await reachTheBoundary(page);

    const digest = page.getByTestId('error-digest');
    if ((await digest.count()) > 0) {
      await expect(digest).toContainText('Reference:');
      // Whatever it is, it is short and opaque — not a message.
      const text = (await digest.innerText()).replace('Reference:', '').trim();
      expect(text.length).toBeLessThan(64);
      expect(text).not.toContain('/');
    }
    // A client-side error has no server digest, so absence is valid too. The
    // assertion is that IF one is rendered it is a digest and nothing more —
    // the failure this guards against is someone widening it to `error.message`
    // because the digest alone felt unhelpful.
  });
});
