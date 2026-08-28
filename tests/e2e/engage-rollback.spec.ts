/**
 * Optimistic rollback, in a real browser (SPEC-009).
 *
 * The sealed criterion:
 *
 *   > "When a clap action rejects, the displayed count reverts to the pre-click
 *   >  server value within 1s (optimistic rollback)."
 *
 * and the rule behind it:
 *
 *   > "All three controls update optimistically via `useOptimistic` and roll
 *   >  back to the server value on failure; the rendered number after a failed
 *   >  mutation must equal the server's number, never the optimistic guess."
 *
 * ── Why the optimistic value is observed with a MutationObserver ─────────
 * A rollback test that only checks the final number cannot tell "rolled back"
 * from "never moved" — a control with no optimistic update at all would pass
 * it. The transient matters, and it lasts only for the burst window plus a
 * round trip, which is too short to poll for reliably. So the tests install an
 * observer BEFORE clicking and read back every value the element ever
 * displayed. The assertion is then about the whole sequence: it rose, and it
 * came back. That is deterministic — it cannot miss the intermediate frame,
 * whereas `expect.poll` can.
 *
 * ── Three ways to reject, because they fail differently ──────────────────
 * 1. TRANSPORT — the action's POST never returns a usable response. Exercised
 *    by intercepting it. This is the case where the client throws and the
 *    rejection has to be caught locally, or React surfaces it to the error
 *    boundary and the reader sees a crashed page instead of an unchanged
 *    number.
 * 2. SERVER SAYS NO — the action returns `{ok:false}`. Exercised by deleting
 *    the article out from under the open page, which makes the real action
 *    answer 404. No interception at all: this is the production path.
 * 3. SESSION GONE — the action returns 401. This one deliberately does NOT
 *    roll back and sit there; it routes to `/signin`, because a reader whose
 *    session expired while the tab was open needs to be told, not to have
 *    every tap silently discarded.
 */

import { expect, test, type Page } from '@playwright/test';

import { appIsBootable } from '../../playwright.config';
import { ARTICLE_STATUS, createArticle, deleteArticle, publishArticle } from '../../lib/db/articles';
import { disconnectDb } from '../../lib/db/client';
import { getClapTotal } from '../../lib/db/social';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

const PASSWORD = 'a quiet afternoon of reading';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/** SPEC-009's criterion fixes the ceiling on the revert. */
const ROLLBACK_BUDGET_MS = 1000;

const PARAGRAPH =
  'A story that exists so a failed mutation has somewhere to fail. It is long ' +
  'enough to scroll and short enough not to matter. ';

function body() {
  return {
    type: 'doc',
    content: Array.from({ length: 4 }, () => ({
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

async function makeArticle(authorId: string, title: string) {
  const article = await createArticle({
    authorId,
    title,
    bodyJson: body(),
    bodyHtml: `<p>${PARAGRAPH.trim()}</p>`,
    status: ARTICLE_STATUS.PUBLISHED,
    now: EPOCH,
  });
  await publishArticle(article.id, EPOCH);
  return article;
}

/**
 * Record every value a control ever displays, from now until it is read.
 *
 * `testId` is looked up inside the footer engagement row so the sticky copy of
 * the same control cannot be picked up instead.
 */
async function recordValues(page: Page, testId: string, key: string) {
  await page.evaluate(
    ({ testId: id, key: storeKey }) => {
      const scope = document.querySelector('[data-testid="article-engagement"]');
      const node = scope?.querySelector(`[data-testid="${id}"]`);
      if (!node) throw new Error(`no ${id} inside the engagement row`);

      const seen: string[] = [node.textContent ?? ''];
      (window as unknown as Record<string, string[]>)[storeKey] = seen;

      new MutationObserver(() => {
        const text = node.textContent ?? '';
        if (seen[seen.length - 1] !== text) seen.push(text);
      }).observe(node, { characterData: true, childList: true, subtree: true });
    },
    { testId, key },
  );
}

async function readValues(page: Page, key: string): Promise<string[]> {
  return page.evaluate(
    (storeKey) => (window as unknown as Record<string, string[]>)[storeKey] ?? [],
    key,
  );
}

/** Make every Server Action POST on `path` fail at the transport level. */
async function breakActions(page: Page, path: string) {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && 'next-action' in request.headers()) {
        await route.fulfill({
          status: 500,
          contentType: 'text/plain',
          body: 'the server declined',
        });
        return;
      }
      await route.continue();
    },
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('SPEC-009 — a failed mutation rolls back to the server value', () => {
  test.skip(!appIsBootable(), 'waiting on TASK-007: no bootable app yet');

  let authorId = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const email = await signUp(page, stamp('rbauth'), 'Rollback Author');
    await page.close();

    const author = await findUserByEmail(email);
    if (!author) throw new Error('sign-up did not create the author');
    authorId = author.id;
  });

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('a rejected clap reverts to the pre-click count within 1s', async ({ browser }) => {
    const article = await makeArticle(authorId, `Rejected clap ${stamp('')}`);
    const path = `/article/${article.slug}`;

    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, stamp('rbclap'), 'Rollback Reader');
    await page.goto(path);

    const total = page.getByTestId('article-engagement').getByTestId('clap-total');
    const before = await total.innerText();

    await recordValues(page, 'clap-total', '__clap');
    await breakActions(page, path);

    const clickedAt = Date.now();
    await page.getByTestId('article-engagement').getByTestId('clap-button').click();

    // The number must come back to exactly what the server last confirmed —
    // "never the optimistic guess".
    await expect(total).toHaveText(before, { timeout: ROLLBACK_BUDGET_MS });
    expect(Date.now() - clickedAt).toBeLessThan(ROLLBACK_BUDGET_MS);

    // It ROSE and then came back, rather than never having moved. Without this
    // a control with no optimistic update at all would pass the test above.
    const seen = await readValues(page, '__clap');
    expect(seen[0]).toBe(before);
    expect(seen).toContain(String(Number(before) + 1));
    expect(seen[seen.length - 1]).toBe(before);

    // And the server genuinely holds the pre-click value: the rollback landed
    // on the truth, not on a lucky guess that matched it.
    expect(await getClapTotal(article.id)).toBe(Number(before));

    await context.close();
    await deleteArticle(article.id);
  });

  test('a rejected bookmark reverts to the pre-click state', async ({ browser }) => {
    // SPEC-009 applies the rollback rule to ALL THREE controls, not only the
    // clap the criterion names.
    const article = await makeArticle(authorId, `Rejected bookmark ${stamp('')}`);
    const path = `/article/${article.slug}`;

    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, stamp('rbbm'), 'Bookmark Reader');
    await page.goto(path);

    const button = page.getByTestId('article-engagement').getByTestId('bookmark-button');
    await expect(button).toHaveAttribute('data-bookmarked', 'false');

    await breakActions(page, path);
    await button.click();

    await expect(button).toHaveAttribute('data-bookmarked', 'false', {
      timeout: ROLLBACK_BUDGET_MS,
    });
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await context.close();
    await deleteArticle(article.id);
  });

  test('a server-side rejection rolls back too — no interception involved', async ({ browser }) => {
    // The production path: the action runs, reaches the database, and answers
    // 404 because the article went away while the tab was open. Nothing about
    // the transport is faked, so this proves the rollback is driven by the
    // RESULT and not by the request failing.
    const article = await makeArticle(authorId, `Vanishing story ${stamp('')}`);
    const path = `/article/${article.slug}`;

    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, stamp('rbgone'), 'Gone Reader');
    await page.goto(path);

    const total = page.getByTestId('article-engagement').getByTestId('clap-total');
    const before = await total.innerText();
    await recordValues(page, 'clap-total', '__gone');

    // Out from under the open page. The cascade takes the claps with it.
    await deleteArticle(article.id);

    await page.getByTestId('article-engagement').getByTestId('clap-button').click();

    await expect(total).toHaveText(before, { timeout: ROLLBACK_BUDGET_MS });

    const seen = await readValues(page, '__gone');
    expect(seen).toContain(String(Number(before) + 1));
    expect(seen[seen.length - 1]).toBe(before);

    // The page did not crash on the way — a rejected mutation is not an
    // application error, and the reader is still reading.
    await expect(page.getByTestId('article-title')).toBeVisible();

    await context.close();
  });

  test('a clap after the session expired routes to sign-in rather than swallowing taps', async ({
    browser,
  }) => {
    // The one rejection that must NOT quietly roll back and stay put: 401.
    // Rolling back forever would leave a reader tapping a control that does
    // nothing and says nothing about why.
    const article = await makeArticle(authorId, `Expired session ${stamp('')}`);
    const path = `/article/${article.slug}`;

    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, stamp('rb401'), 'Expired Reader');
    await page.goto(path);

    await expect(
      page.getByTestId('article-engagement').getByTestId('clap-button'),
    ).toHaveAttribute('data-signed-in', 'true');

    // The session goes away while the page sits open — the control was
    // rendered signed-in and the cookie is now gone.
    await context.clearCookies();

    await page.getByTestId('article-engagement').getByTestId('clap-button').click();

    await page.waitForURL(`**/signin?next=${encodeURIComponent(path)}`, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();

    // And nothing was written on the way out.
    expect(await getClapTotal(article.id)).toBe(0);

    await context.close();
    await deleteArticle(article.id);
  });
});
