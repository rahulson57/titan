/**
 * Draft privacy over HTTP (SPEC-005).
 *
 * Sealed criterion: "Requesting a DRAFT article's URL as a non-author (and as
 * an anonymous visitor) returns HTTP 404, and as the author returns 200."
 *
 * ── This suite is armed, not skipped ───────────────────────────────────────
 * The criterion is about a status code on `/article/[slug]`, and that route is
 * owned by SPEC-009 (TASK-009, Reading & Engagement) — a later slice. There is
 * nothing to request yet, so the HTTP half cannot execute today.
 *
 * The project already has a shape for exactly this, and it is the one used
 * here rather than a comment saying "TODO when TASK-009 lands":
 * `tests/helpers/db.ts` calls them capability probes, and `boot.spec.ts` uses
 * the same pattern for the app entry point. The assertions below are the REAL
 * ones. They state the criterion in full, they name the task that unblocks
 * them, and they arm themselves the moment that route file appears — no edit
 * to this file required when it does.
 *
 * A suite guarded this way is not a suite that was skipped. It is a suite that
 * is waiting, and the skip line says what it is waiting on.
 *
 * ── The rule itself is proven NOW, at the unit level ───────────────────────
 * What TASK-004 actually owns is the decision, not the route: `canViewArticle`
 * and `authorizationFor(..., 'read')` in `lib/auth/session.ts`, which
 * `tests/unit/authz-article.test.ts` exercises across every (viewer, status)
 * pair — including the 404-not-403 distinction that is the whole point. So the
 * rule is verified in this slice; only its wiring to a URL waits for the slice
 * that owns the URL.
 *
 * If TASK-009 ever renders a draft to a stranger, it will be because it did
 * not call `requireVisibleArticle`, which is why that function returns the
 * article rather than a boolean — the check is on the path to the data, not
 * beside it.
 *
 * ── Database access ───────────────────────────────────────────────────────
 * Through `lib/db/`, never a client of its own: SPEC-004's boundary rule holds
 * for test files too, and `tests/unit/db-boundary.test.ts` enforces it.
 */

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { disconnectDb, getDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * True once SPEC-009 has landed the article route this criterion is about.
 *
 * Checked as a file on disk rather than by probing a URL: a 404 from a route
 * that does not exist and a 404 from draft privacy working correctly are the
 * same response, so probing would let this suite "pass" for entirely the wrong
 * reason the day before the feature was written.
 */
function hasArticleRoute(): boolean {
  return ['tsx', 'jsx', 'js'].some((ext) =>
    existsSync(join(REPO_ROOT, 'app', 'article', '[slug]', `page.${ext}`)),
  );
}

const WAITING_ON =
  'waiting on TASK-009 (SPEC-009): app/article/[slug]/page.tsx does not exist yet, so a ' +
  'DRAFT has no URL to request. The rule itself is proven in tests/unit/authz-article.test.ts.';

/** The seeded demo password every generated user shares (SPEC-005). */
const SEEDED_PASSWORD = 'titan1234';

async function firstArticle(status: 'DRAFT' | 'PUBLISHED') {
  return getDb().article.findFirst({
    where: { status },
    select: { slug: true, authorId: true, author: { select: { email: true } } },
  });
}

test.describe('SPEC-005 — drafts are visible only to their author', () => {
  test.skip(!hasArticleRoute(), WAITING_ON);

  const createdEmails: string[] = [];

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('an anonymous visitor gets 404 for a draft', async ({ page }) => {
    const draft = await firstArticle('DRAFT');
    test.skip(!draft, 'the seed corpus contains no DRAFT article to request');

    const response = await page.goto(`/article/${draft?.slug}`);
    // 404, NOT 403: a 403 would confirm the slug names a real unpublished
    // article, turning a guessable URL into an oracle that leaks an author's
    // titles one guess at a time.
    expect(response?.status()).toBe(404);
  });

  test('a signed-in non-author gets 404 for a draft', async ({ page }) => {
    const draft = await firstArticle('DRAFT');
    test.skip(!draft, 'the seed corpus contains no DRAFT article to request');

    // Somebody who is definitely not the author. Created through the sign-up
    // form rather than the repository, so the session this test carries is a
    // real one produced by the real flow.
    const stamp = Date.now().toString(36);
    const email = `nota-${stamp}@titan.local`;
    createdEmails.push(email);

    await page.goto('/signup');
    await page.getByLabel('Name').fill('Not The Author');
    await page.getByLabel('Handle').fill(`nota_${stamp}`.slice(0, 24));
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a quiet afternoon of reading');
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForURL('/');

    const response = await page.goto(`/article/${draft?.slug}`);
    expect(response?.status()).toBe(404);
  });

  test('the author gets 200 for their own draft', async ({ page }) => {
    const draft = await firstArticle('DRAFT');
    test.skip(!draft, 'the seed corpus contains no DRAFT article to request');

    await page.goto('/signin');
    await page.getByLabel('Email').fill(draft?.author.email ?? '');
    await page.getByLabel('Password').fill(SEEDED_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL('/');

    const response = await page.goto(`/article/${draft?.slug}`);
    expect(response?.status()).toBe(200);
  });

  test('a published article is 200 for everyone, including anonymous', async ({ page }) => {
    // The control. Without it, a route that 404s on EVERYTHING would satisfy
    // the three assertions above and look like working draft privacy.
    const published = await firstArticle('PUBLISHED');
    test.skip(!published, 'the seed corpus contains no PUBLISHED article to request');

    const response = await page.goto(`/article/${published?.slug}`);
    expect(response?.status()).toBe(200);
  });
});
