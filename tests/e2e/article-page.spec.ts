/**
 * `/article/[slug]` — the reading surface, in a real browser (SPEC-009).
 *
 * Three sealed criteria land here:
 *
 *   - "`/article/[slug]` for a published article returns HTTP 200 and renders
 *      title, author handle, `readingMinutes` and body text."
 *   - "An unknown slug returns HTTP 404 (not 500)."
 *   - "As an anonymous visitor, clicking the clap control navigates to
 *      `/signin?next=/article/<slug>` and no error is thrown."
 *
 * ── Why the fixture is built here rather than taken from the seed ────────
 * The seed corpus is deterministic but its slugs are `kebab(title)-<6 chars of
 * the article id>` (SPEC-004), so no slug in it is a name this file could
 * write down without coupling to the seed's internals. Building the article
 * through `lib/db/` gives this suite a slug it knows, a body it can assert the
 * text of, and a `readingMinutes` it can predict — and it cleans up after
 * itself through the cascade.
 *
 * ── On reading the development database ──────────────────────────────────
 * Same posture as `tests/e2e/auth.spec.ts` and `bookmarks-page.spec.ts`: the
 * thing under test IS the dev server, which has one database, and this suite
 * observes it through `lib/db/` — never by constructing a Prisma client of its
 * own, which `tests/unit/db-boundary.test.ts` forbids and which would run with
 * `foreign_keys` OFF, disabling the cascade this suite cleans up with.
 */

import { expect, test, type Page } from '@playwright/test';

import { appIsBootable } from '../../playwright.config';
import { hashPassword } from '../../lib/auth/password';
import { ARTICLE_STATUS, createArticle, publishArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import { setArticleTags } from '../../lib/db/tags';
import { createUser, deleteUser, findUserByEmail } from '../../lib/db/users';

/** Long, unremarkable, and deliberately not on the 200-entry denylist. */
const PASSWORD = 'a quiet afternoon of reading';

/** Fixed instant — the byline is asserted, so it must not depend on today. */
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * A sentence repeated enough times to make `readingMinutes` predictable and
 * greater than one, so the assertion is not satisfied by the `Math.ceil`
 * floor of 1 that any non-empty body would produce.
 */
const PARAGRAPH =
  'The reading page is the product, and everything else on it is in service of ' +
  'the words. This paragraph exists so the derived reading time is a number ' +
  'worth asserting rather than the floor every article shares. ';

function body(times: number) {
  return {
    type: 'doc',
    content: Array.from({ length: times }, () => ({
      type: 'paragraph',
      content: [{ type: 'text', text: PARAGRAPH }],
    })),
  };
}

let seq = 0;
function stamp(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${seq++}`;
}

const createdEmails: string[] = [];

async function signUp(page: Page, account: { email: string; handle: string; name: string }) {
  createdEmails.push(account.email);
  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL('/');
}

test.describe.configure({ mode: 'serial' });

test.describe('SPEC-009 — the article reading page', () => {
  test.skip(!appIsBootable(), 'waiting on TASK-007: no bootable app yet');

  let slug = '';
  let draftSlug = '';
  let authorHandle = '';
  let readingMinutes = 0;

  test.beforeAll(async () => {
    const handle = stamp('artauth');
    const email = `${handle}@titan.local`;
    createdEmails.push(email);

    const author = await createUser({
      email,
      passwordHash: await hashPassword(PASSWORD),
      handle,
      name: 'Fixture Author',
      bio: 'Writes about the things that take a while to say.',
      createdAt: EPOCH,
    });
    authorHandle = author.handle;

    const article = await createArticle({
      authorId: author.id,
      title: `A story to read ${stamp('')}`,
      subtitle: 'And a subtitle underneath it',
      bodyJson: body(12),
      bodyHtml: Array.from({ length: 12 }, () => `<p>${PARAGRAPH.trim()}</p>`).join(''),
      status: ARTICLE_STATUS.PUBLISHED,
      now: EPOCH,
    });
    await publishArticle(article.id, EPOCH);
    await setArticleTags(article.id, ['reading', 'craft']);

    slug = article.slug;
    readingMinutes = article.readingMinutes;
    // The fixture is only meaningful if it is long enough to have a read time
    // above the one-minute floor every article shares.
    expect(readingMinutes).toBeGreaterThan(1);

    const draft = await createArticle({
      authorId: author.id,
      title: `An unfinished story ${stamp('')}`,
      bodyJson: body(2),
      bodyHtml: `<p>${PARAGRAPH.trim()}</p>`,
      status: ARTICLE_STATUS.DRAFT,
      now: EPOCH,
    });
    draftSlug = draft.slug;
  });

  test.afterAll(async () => {
    // The cascade takes the articles, tags, claps and sessions with the users.
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('a published article returns 200 and renders title, handle, read time and body', async ({
    page,
  }) => {
    const response = await page.goto(`/article/${slug}`);

    // The STATUS, not just the markup. A soft 200 carrying an error would
    // satisfy every assertion below and none of the criterion.
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('article-title')).toBeVisible();
    await expect(page.getByTestId('author-handle')).toHaveText(`@${authorHandle}`);
    await expect(page.getByTestId('reading-time')).toHaveText(`${readingMinutes} min read`);

    // The BODY TEXT, from the server-rendered HTML — this is the LCP element
    // and the thing a reader came for.
    await expect(page.getByTestId('prose')).toContainText(PARAGRAPH.trim().slice(0, 60));

    // The byline date is formatted through lib/format/date.ts, in UTC, so it
    // is the same string on the server and in the browser.
    await expect(page.getByTestId('published-at')).toHaveText('Jan 1, 2026');
  });

  test('the page composition SPEC-009 specifies is actually on the page', async ({ page }) => {
    await page.goto(`/article/${slug}`);

    await expect(page.getByTestId('article-subtitle')).toBeVisible();
    await expect(page.getByTestId('article-tags')).toBeVisible();
    // Tag chips link to /tag/[slug] (SPEC-009's footer row).
    await expect(page.getByTestId('article-tags').getByRole('link').first()).toHaveAttribute(
      'href',
      /^\/tag\//,
    );
    await expect(page.getByTestId('author-card')).toBeVisible();
    await expect(page.getByTestId('author-bio')).toBeVisible();
    await expect(page.getByTestId('follower-count')).toBeVisible();
    await expect(page.getByTestId('reading-progress')).toHaveCount(1);
  });

  test('the reading-progress bar is 3px and fills as the body scrolls past', async ({ page }) => {
    await page.goto(`/article/${slug}`);
    await page.setViewportSize({ width: 1280, height: 720 });

    const bar = page.getByTestId('reading-progress');
    await expect(bar).toHaveCSS('height', '3px');

    const fill = page.getByTestId('reading-progress-fill');
    const widthAt = async () =>
      Number((await fill.evaluate((node) => getComputedStyle(node).width)).replace('px', ''));

    const atTop = await widthAt();

    await page.keyboard.press('End');
    // The bar writes at most once per animation frame and eases over 90ms.
    await expect
      .poll(widthAt, { timeout: 2000 })
      .toBeGreaterThan(atTop + 10);
  });

  test('the sticky bar is hidden at the top and 56px tall once the header leaves', async ({
    page,
  }) => {
    await page.goto(`/article/${slug}`);

    const bar = page.getByTestId('sticky-bar');
    // Always mounted — mounting it on the crossing would be a layout shift
    // against the CLS budget — but hidden, and hidden in a way that also takes
    // it out of the tab order rather than leaving invisible focus targets.
    await expect(bar).toHaveAttribute('data-shown', 'false');
    await expect(bar).toHaveCSS('visibility', 'hidden');
    await expect(bar).toHaveCSS('height', '56px');

    await page.keyboard.press('End');
    await expect(bar).toHaveAttribute('data-shown', 'true');
    await expect(bar).toHaveCSS('visibility', 'visible');
    await expect(page.getByTestId('sticky-title')).toBeVisible();
  });

  test('the hidden sticky bar is not a focus trap and never fades its text', async ({ page }) => {
    await page.goto(`/article/${slug}`);

    // `visibility: hidden` — not `opacity: 0` — is what hides it, and the
    // difference is the whole point: an opacity-0 button is still tabbable, so
    // a reader tabbing from the top of the article would land on invisible
    // controls sitting over the page. This walks the tab order and asserts
    // nothing inside the bar can be reached while it is down.
    const reachable: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? Boolean(el.closest('[data-testid="sticky-bar"]')) : false;
      });
      if (inside) reachable.push(String(i));
    }
    expect(reachable, 'the hidden sticky bar must be out of the tab order').toEqual([]);

    // And the bar animates by SLIDING, never by fading. A transitioning
    // opacity blends `--fg` toward `--bg`, which axe reports as a serious
    // contrast violation for as long as the transition lasts (measured at
    // 4.41:1 against a 4.5:1 floor). Pinned here so nobody restores the fade.
    const style = await page.getByTestId('sticky-bar').evaluate((node) => {
      const computed = getComputedStyle(node);
      return { opacity: computed.opacity, property: computed.transitionProperty };
    });
    expect(style.opacity).toBe('1');
    expect(style.property).not.toContain('opacity');
  });

  test('an unknown slug returns HTTP 404, not 500', async ({ page }) => {
    const response = await page.goto('/article/no-such-article-exists-here');

    // The criterion names the failure mode explicitly: a 500 would mean the
    // page threw on a missing row instead of calling notFound().
    expect(response?.status()).toBe(404);
    expect(response?.status()).not.toBe(500);
  });

  test('a draft is a 404 for a stranger, not a 403 — the article is not confirmed', async ({
    page,
  }) => {
    // SPEC-005: drafts are visible only to their author. A 403 would confirm
    // the article exists, which is exactly the fact the rule protects. So the
    // answer must be byte-identical to the unknown-slug answer above.
    const response = await page.goto(`/article/${draftSlug}`);
    expect(response?.status()).toBe(404);
  });

  test('an anonymous clap click navigates to /signin?next=/article/<slug>', async ({ page }) => {
    await page.goto(`/article/${slug}`);

    // Scoped to the footer row on purpose. SPEC-009 puts a second copy of this
    // control in the sticky bar, so a bare `getByTestId` matches two elements
    // and Playwright's strict mode rejects it — correctly. The duplication is
    // the feature; the locator has to say which copy it means.
    const clap = page.getByTestId('article-engagement').getByTestId('clap-button');
    // Signed out the control is an ANCHOR, not a button: it navigates, which
    // is what makes "rather than erroring" structural instead of a promise.
    await expect(clap).toHaveAttribute('data-signed-in', 'false');

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await clap.click();

    // `signInHref` percent-encodes the return path, as it does for /bookmarks
    // — `safeNextPath` re-validates it on the way back out (SPEC-005).
    await page.waitForURL(`**/signin?next=${encodeURIComponent(`/article/${slug}`)}`);
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();

    // "and no error is thrown" — asserted, not assumed.
    expect(errors).toEqual([]);
  });

  test('every anonymous engagement control routes to sign-in rather than erroring', async ({
    page,
  }) => {
    // SPEC-009: "every engagement control renders in a signed-out state that
    // routes to /signin?next=<path>". All three, not just the clap.
    await page.goto(`/article/${slug}`);

    const expected = `/signin?next=${encodeURIComponent(`/article/${slug}`)}`;
    // Each control is scoped to one of its two homes — clap and bookmark to the
    // footer row, follow to the author card — because every one of them is
    // deliberately rendered twice.
    const controls = [
      page.getByTestId('article-engagement').getByTestId('clap-button'),
      page.getByTestId('article-engagement').getByTestId('bookmark-button'),
      page.getByTestId('author-card').getByTestId('follow-button'),
    ];
    for (const control of controls) {
      await expect(control).toHaveAttribute('data-signed-in', 'false');
      await expect(control).toHaveAttribute('href', expected);
    }
  });

  test('a signed-in reader gets real controls, and the clap count moves', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const handle = stamp('artreader');
    await signUp(page, { email: `${handle}@titan.local`, handle, name: 'Article Reader' });

    await page.goto(`/article/${slug}`);

    const clap = page.getByTestId('article-engagement').getByTestId('clap-button');
    await expect(clap).toHaveAttribute('data-signed-in', 'true');

    const total = page.getByTestId('article-engagement').getByTestId('clap-total');
    const before = Number(await total.innerText());

    // Wait for the ACTION's own response, not just for the number to change.
    // The optimistic layer satisfies `before + 1` the instant the button is
    // pressed — a reload triggered on that alone would navigate away while the
    // 400ms burst was still open, cancel the in-flight action, and read back a
    // count the server never received. That is a genuine property of
    // client-side coalescing, and the test has to respect it rather than race
    // it: a reader who leaves within the window loses the burst, by design.
    const actionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/article/${slug}`,
      { timeout: 10_000 },
    );

    await clap.click();
    await expect(total).toHaveText(String(before + 1), { timeout: 5000 });
    expect((await actionResponse).status()).toBe(200);

    // And it is the SERVER's number, not the optimistic guess: a reload reads
    // the row back off disk.
    await page.reload();
    await expect(
      page.getByTestId('article-engagement').getByTestId('clap-total'),
    ).toHaveText(String(before + 1));

    await context.close();
  });

  test('the follow control is not rendered on your own article', async ({ browser }) => {
    // Nobody follows themselves; the server answers 400 and the UI never
    // offers the button, so that 400 is unreachable through the page.
    const context = await browser.newContext();
    const page = await context.newPage();
    const handle = stamp('selfauth');
    const email = `${handle}@titan.local`;
    await signUp(page, { email, handle, name: 'Self Author' });

    const author = await findUserByEmail(email);
    if (!author) throw new Error('sign-up did not create the author');

    const own = await createArticle({
      authorId: author.id,
      title: `My own story ${stamp('')}`,
      bodyJson: body(3),
      bodyHtml: `<p>${PARAGRAPH.trim()}</p>`,
      status: ARTICLE_STATUS.PUBLISHED,
      now: EPOCH,
    });
    await publishArticle(own.id, EPOCH);

    await page.goto(`/article/${own.slug}`);
    await expect(page.getByTestId('article-title')).toBeVisible();
    await expect(page.getByTestId('follow-button')).toHaveCount(0);

    await context.close();
  });

  test('the author can read their own draft at its slug', async ({ browser }) => {
    // The other half of the draft rule: 404 for a stranger, 200 for the owner.
    const context = await browser.newContext();
    const page = await context.newPage();

    const author = await findUserByEmail(createdEmails[0] ?? '');
    if (!author) throw new Error('the fixture author is missing');

    await page.goto('/signin');
    await page.getByLabel('Email').fill(author.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL('/');

    const response = await page.goto(`/article/${draftSlug}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('article-title')).toBeVisible();

    await context.close();
  });
});
