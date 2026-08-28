/**
 * Clap coalescing, in a real browser (SPEC-009).
 *
 * The sealed criterion:
 *
 *   > "Ten clap taps within 400 ms issue exactly one server action call."
 *
 * ── How a Server Action call is counted ──────────────────────────────────
 * Next posts a Server Action to the CURRENT page URL and marks it with a
 * `next-action` request header carrying the action's id. That header is what
 * distinguishes an action invocation from a navigation, an RSC prefetch or a
 * form post to the same path — all of which would be miscounted by a naive
 * "POSTs to this URL" filter. So the counter keys on the header, and the
 * assertion is about invocations rather than about traffic.
 *
 * ── Why the taps are dispatched inside the page ──────────────────────────
 * `locator.click()` does a hit test, scrolls the element into view and moves
 * the mouse — tens of milliseconds each, and ten of them can exceed the very
 * 400 ms window under test on a loaded machine. That would turn a correct
 * implementation red for reasons that have nothing to do with coalescing. One
 * `evaluate` dispatching ten clicks runs in a single task, so the burst is
 * unambiguously inside the window by construction and the test measures the
 * component rather than the harness.
 *
 * ── On reading the development database ──────────────────────────────────
 * Same posture as the sibling specs: observed through `lib/db/`, never through
 * a Prisma client of this suite's own.
 */

import { expect, test, type Page } from '@playwright/test';

import { appIsBootable } from '../../playwright.config';
import { ARTICLE_STATUS, createArticle, publishArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import { getClapByReader, getClapTotal } from '../../lib/db/social';
import { deleteUser, findUserByEmail } from '../../lib/db/users';
import { CLAP_BURST_MS } from '../../lib/engage/clap';

const PASSWORD = 'a quiet afternoon of reading';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const TAPS = 10;

const PARAGRAPH =
  'A story long enough to have a footer worth scrolling to, and short enough ' +
  'that the suite does not spend its budget rendering prose. ';

/**
 * Long enough that the header genuinely scrolls out of the viewport.
 *
 * The sticky bar arms on the header LEAVING the viewport, so a fixture short
 * enough to fit on one screen never arms it — and the test would fail for
 * having nothing to scroll rather than for anything about the component.
 */
const PARAGRAPH_COUNT = 16;

function body() {
  return {
    type: 'doc',
    content: Array.from({ length: PARAGRAPH_COUNT }, () => ({
      type: 'paragraph',
      content: [{ type: 'text', text: PARAGRAPH }],
    })),
  };
}

/**
 * The rendered body, derived from the SAME paragraph count as `body()`.
 *
 * `bodyJson` and `bodyHtml` are separate columns and only `bodyHtml` reaches
 * the page — `bodyJson` feeds `bodyText` and `readingMinutes`. A fixture that
 * builds sixteen paragraphs of JSON and one paragraph of HTML renders a page
 * one paragraph tall, which is exactly how this fixture was first written and
 * why the scroll assertion below could not arm. Deriving both from one
 * constant makes them unable to disagree.
 */
function bodyHtml() {
  return Array.from({ length: PARAGRAPH_COUNT }, () => `<p>${PARAGRAPH.trim()}</p>`).join('');
}

let seq = 0;
function stamp(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${seq++}`;
}

const createdEmails: string[] = [];

async function signUp(page: Page, handle: string, name: string) {
  const email = `${handle}@titan.local`;
  createdEmails.push(email);
  await page.goto('/signup');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Handle').fill(handle);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL('/');
  return email;
}

/**
 * Count Server Action invocations on this page.
 *
 * Returns a getter rather than a number so the caller reads the count AFTER
 * the burst has settled, without having to thread a mutable box around.
 */
function countActionCalls(page: Page, path: string): () => number {
  let calls = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (new URL(request.url()).pathname !== path) return;
    if (!('next-action' in request.headers())) return;
    calls += 1;
  });
  return () => calls;
}

test.describe.configure({ mode: 'serial' });

test.describe('SPEC-009 — clap taps are coalesced into one call per 400ms burst', () => {
  test.skip(!appIsBootable(), 'waiting on TASK-007: no bootable app yet');

  let slug = '';
  let articleId = '';
  let readerId = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const authorEmail = await signUp(page, stamp('coalauth'), 'Coalesce Author');
    await page.close();

    const author = await findUserByEmail(authorEmail);
    if (!author) throw new Error('sign-up did not create the author');

    const article = await createArticle({
      authorId: author.id,
      title: `Coalesced claps ${stamp('')}`,
      bodyJson: body(),
      bodyHtml: bodyHtml(),
      status: ARTICLE_STATUS.PUBLISHED,
      now: EPOCH,
    });
    await publishArticle(article.id, EPOCH);
    slug = article.slug;
    articleId = article.id;
  });

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test(`${TAPS} taps within ${CLAP_BURST_MS}ms issue exactly one server action call`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const readerEmail = await signUp(page, stamp('coalreader'), 'Coalesce Reader');
    const reader = await findUserByEmail(readerEmail);
    if (!reader) throw new Error('sign-up did not create the reader');
    readerId = reader.id;

    const path = `/article/${slug}`;
    const actionCalls = countActionCalls(page, path);

    await page.goto(path);
    const total = page.getByTestId('article-engagement').getByTestId('clap-total');
    await expect(total).toHaveText('0');

    // Ten clicks in one task — unambiguously inside the window.
    await page
      .getByTestId('article-engagement')
      .getByTestId('clap-button')
      .evaluate((node, taps) => {
        for (let i = 0; i < taps; i += 1) (node as HTMLElement).click();
      }, TAPS);

    // The optimistic layer shows all ten immediately; the server confirms the
    // same number once the single call returns.
    await expect(total).toHaveText(String(TAPS), { timeout: 5000 });

    // Give any straggler call a chance to appear before counting, so "exactly
    // one" is a real assertion rather than a race the test happened to win.
    await page.waitForTimeout(CLAP_BURST_MS * 3);

    expect(
      actionCalls(),
      `${TAPS} taps inside the ${CLAP_BURST_MS}ms window should coalesce into one action call`,
    ).toBe(1);

    // And the one call carried all ten claps — coalescing that dropped nine
    // taps would also produce exactly one call.
    expect(await getClapByReader(readerId, articleId)).toBe(TAPS);
    expect(await getClapTotal(articleId)).toBe(TAPS);

    await context.close();
  });

  test('taps in separate windows are separate calls — the burst is bounded, not a debounce', async ({
    browser,
  }) => {
    // The complement of the criterion, and the reason the window is anchored
    // to the first tap rather than reset by each one. A trailing debounce
    // would also pass the test above, and would then let a reader who keeps
    // tapping push the deadline back forever without anything being sent.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, stamp('coalgap'), 'Gap Reader');

    const path = `/article/${slug}`;
    const actionCalls = countActionCalls(page, path);

    await page.goto(path);
    const total = page.getByTestId('article-engagement').getByTestId('clap-total');
    const before = Number(await total.innerText());

    await page.getByTestId('article-engagement').getByTestId('clap-button').click();
    await expect(total).toHaveText(String(before + 1), { timeout: 5000 });

    // Well clear of the window, so this tap cannot join the first burst.
    await page.waitForTimeout(CLAP_BURST_MS * 3);

    await page.getByTestId('article-engagement').getByTestId('clap-button').click();
    await expect(total).toHaveText(String(before + 2), { timeout: 5000 });

    await page.waitForTimeout(CLAP_BURST_MS * 3);
    expect(actionCalls()).toBe(2);

    await context.close();
  });

  test('both copies of the control show one number, in the footer and the sticky bar', async ({
    browser,
  }) => {
    // SPEC-009 puts a clap control in the footer AND in the sticky bar, and at
    // the foot of an article both are on screen. Two independent optimistic
    // states would let them disagree — this is the assertion that the shared
    // provider is actually shared.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, stamp('coalboth'), 'Both Reader');

    // A short viewport, so the header is guaranteed to leave it on scroll no
    // matter how the fixture's prose happens to wrap.
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto(`/article/${slug}`);

    // Asserted, not assumed: if the fixture ever stopped being taller than the
    // viewport there would be nothing to scroll, and the sticky-bar assertion
    // below would fail for a reason that has nothing to do with the component.
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(scrollable, 'the fixture article must be taller than the viewport').toBeGreaterThan(200);

    // An explicit scroll of the document, rather than `scrollIntoViewIfNeeded`
    // or an `End` keypress: both depend on what currently has focus or on how
    // much of the target is already visible, and the property under test is
    // simply "the header has left the viewport".
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.getByTestId('sticky-bar')).toHaveAttribute('data-shown', 'true');

    const footer = page.getByTestId('article-engagement').getByTestId('clap-total');
    const sticky = page.getByTestId('sticky-bar').getByTestId('clap-total');

    const before = Number(await footer.innerText());
    await expect(sticky).toHaveText(String(before));

    await page.getByTestId('sticky-bar').getByTestId('clap-button').click();

    await expect(footer).toHaveText(String(before + 1), { timeout: 5000 });
    await expect(sticky).toHaveText(String(before + 1));

    await context.close();
  });
});
