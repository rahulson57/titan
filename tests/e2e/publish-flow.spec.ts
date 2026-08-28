/**
 * The publish state machine, in the browser (SPEC-007).
 *
 * Sealed criterion:
 *
 * > Unpublishing removes the article from the home feed and from FTS results
 * > while keeping its row.
 *
 * ── This suite is armed, not skipped ──────────────────────────────────────
 * The criterion has three clauses and they do not become verifiable at the same
 * time, so they are treated separately rather than being bundled behind one
 * skip:
 *
 *  - **"keeping its row"** — verifiable NOW, and asserted unconditionally
 *    below. It is also the clause most worth pinning, because the tempting
 *    implementation of "remove from the feed" is a delete.
 *  - **"removes from the home feed"** — `app/page.tsx` is still S01's
 *    placeholder; the ranked feed is SPEC-008 (TASK-007, Feed & Search). There
 *    is no feed to disappear from yet.
 *  - **"and from FTS results"** — `article_fts` exists (the initial migration
 *    creates the virtual table) but its write TRIGGERS are owned by SPEC-008
 *    too, and the migration says so in its own comment. Nothing in this slice
 *    writes the index, deliberately: the triggers key off `Article.status`, so
 *    publishing correctly here IS indexing the moment they land. Writing the
 *    index by hand from `lib/content/publish.ts` would give the search corpus
 *    two authors that have to agree, and the failure mode is an article that is
 *    published but unfindable.
 *
 * The last two are therefore capability-guarded, with the real assertions
 * written out in full, naming TASK-007 as the unblocker. They arm themselves
 * when it lands and need no edit to this file. This is the shape
 * `tests/e2e/draft-privacy.spec.ts` established and `tests/helpers/db.ts` calls
 * a capability probe.
 */

import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable } from '../../playwright.config';
import { disconnectDb, getDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';
import { createArticle, getArticleById } from '../../lib/db/articles';
import { MIN_BODY_TEXT_CHARS } from '../../lib/content/publish';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * True once SPEC-008 has landed a home feed.
 *
 * Checked as "the placeholder is gone" rather than "the file exists":
 * `app/page.tsx` is present today as S01's boot placeholder, which says so in
 * its own header. Probing for the file would arm this suite against a page that
 * renders no articles at all, and it would pass for entirely the wrong reason.
 */
function hasHomeFeed(): boolean {
  const page = join(REPO_ROOT, 'app', 'page.tsx');
  if (!existsSync(page)) return false;
  return !readFileSync(page, 'utf8').includes('PLACEHOLDER');
}

/** True once SPEC-008's triggers maintain `article_fts`. */
async function hasFtsTriggers(): Promise<boolean> {
  const rows = await getDb().$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'Article'",
  );
  return rows.length > 0;
}

const WAITING_ON_FEED =
  'waiting on TASK-007 (SPEC-008): app/page.tsx is still S01’s boot placeholder, so there is ' +
  'no ranked home feed for an unpublished article to disappear from.';

const WAITING_ON_FTS =
  'waiting on TASK-007 (SPEC-008): article_fts exists but its write triggers do not. The ' +
  'initial migration states that those triggers are SPEC-008’s, and they key off ' +
  'Article.status — so this arms itself the moment they land.';

const createdEmails: string[] = [];

function freshAccount() {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return {
    name: 'Publishing Author',
    handle: `pub_${stamp}`.slice(0, 24),
    email: `pub-${stamp}@titan.local`,
    password: 'a quiet afternoon of reading',
  };
}

/** Sign up, then create a draft owned by that author. `body` sets its length. */
async function openDraft(page: Page, body: string): Promise<string> {
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
  if (!user) throw new Error('sign-up did not create a user');

  const article = await createArticle({
    authorId: user.id,
    title: 'A piece ready to publish',
    bodyJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
    bodyHtml: `<p>${body}</p>`,
  });

  await page.goto(`/editor/${article.id}`, { waitUntil: 'networkidle' });
  return article.id;
}

/** A body comfortably over the 50-character floor. */
const GOOD_BODY =
  'A paragraph with enough words in it to clear the fifty-character floor the publish guard sets.';

async function addTag(page: Page, name: string) {
  // `exact: true` throughout: `getByLabel` substring-matches by default, and
  // this page also has a "Subtitle" field, so a loose "Title" would resolve to
  // two elements.
  await page.getByLabel('Tags', { exact: true }).fill(name);
  await page.getByLabel('Tags', { exact: true }).press('Enter');
}

test.describe('SPEC-007 — publishing', () => {
  test.skip(!appIsBootable(), 'no bootable app yet');

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('a valid draft publishes, gaining a slug and a publishedAt', async ({ page }) => {
    const articleId = await openDraft(page, GOOD_BODY);
    await expect(page.getByTestId('article-status')).toHaveText('Draft');

    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();

    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    const stored = await getArticleById(articleId);
    expect(stored?.status).toBe('PUBLISHED');
    expect(stored?.publishedAt).not.toBeNull();
    expect(stored?.slug).toMatch(/^a-piece-ready-to-publish-[0-9a-z]{6}$/);
  });

  /*
   * The three rejection cases are written out rather than tabulated. Playwright's
   * `test` has no `.each` (that is Vitest's), and each case sets its fixture up
   * differently — a short body has to be created with the article, while a
   * cleared title and a missing tag are form states. Driven through the real
   * form in every case, because the criterion says "is rejected with a
   * FIELD-LEVEL error", which is a statement about what the author SEES.
   * `tests/unit/publish-guards.test.ts` proves the guard itself, exhaustively
   * and at the boundary; these prove it is wired to something a person can read.
   */

  test('refuses an empty title with a field-level error and stays a Draft', async ({ page }) => {
    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('article-title').fill('');

    await page.getByTestId('publish-button').click();

    await expect(page.getByRole('alert').filter({ hasText: /title/i })).toBeVisible();
    await expect(page.getByTestId('article-status')).toHaveText('Draft');

    // The row is untouched — not merely still a draft, but not written at all.
    // A "publish then roll back" implementation would have bumped `version`,
    // and the author's next autosave would then collide with a save nobody made.
    const stored = await getArticleById(articleId);
    expect(stored?.status).toBe('DRAFT');
    expect(stored?.publishedAt).toBeNull();
    expect(stored?.version).toBe(1);
  });

  test('refuses a body under the floor with a field-level error and stays a Draft', async ({
    page,
  }) => {
    const articleId = await openDraft(page, 'too short');
    await addTag(page, 'craft');

    await page.getByTestId('publish-button').click();

    await expect(page.getByRole('alert').filter({ hasText: /characters/i })).toBeVisible();
    await expect(page.getByTestId('article-status')).toHaveText('Draft');
    expect((await getArticleById(articleId))?.status).toBe('DRAFT');
    expect(MIN_BODY_TEXT_CHARS).toBe(50);
  });

  test('refuses zero tags with a field-level error and stays a Draft', async ({ page }) => {
    const articleId = await openDraft(page, GOOD_BODY);

    await page.getByTestId('publish-button').click();

    await expect(page.getByRole('alert').filter({ hasText: /tag/i })).toBeVisible();
    await expect(page.getByTestId('article-status')).toHaveText('Draft');
    expect((await getArticleById(articleId))?.status).toBe('DRAFT');
  });

  test('the tag field refuses a sixth tag', async ({ page }) => {
    await openDraft(page, GOOD_BODY);
    for (const tag of ['one', 'two', 'three', 'four', 'five']) await addTag(page, tag);

    await expect(page.getByTestId('tag-list').getByRole('listitem')).toHaveCount(5);
    // Disabled rather than accepted-and-rejected: the ceiling is SPEC-004's and
    // the repository enforces it, but an author should not be able to type a
    // sixth tag and only find out when they press Publish.
    await expect(page.getByLabel('Tags', { exact: true })).toBeDisabled();
  });

  test('an edit and a republish leave slug and publishedAt byte-identical', async ({ page }) => {
    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    const first = await getArticleById(articleId);

    // A real edit through the real editor, INCLUDING a new title — the case
    // that would move the URL if the slug freeze were not holding.
    await page.getByTestId('article-title').fill('A completely different title');
    await page.getByTestId('editor-body').click();
    await page.getByTestId('editor-body').pressSequentially(' More words.', { delay: 20 });
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });

    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    const second = await getArticleById(articleId);
    expect(second?.title).toBe('A completely different title');
    expect(second?.slug).toBe(first?.slug);
    expect(second?.publishedAt?.toISOString()).toBe(first?.publishedAt?.toISOString());
  });

  test('unpublishing keeps the row, the slug and publishedAt', async ({ page }) => {
    // The clause of the criterion that is verifiable today, and the one most
    // worth pinning: the tempting implementation of "remove it from the feed"
    // is a delete, which would take the author's work with it.
    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });
    const published = await getArticleById(articleId);

    await page.getByTestId('unpublish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Draft', { timeout: 15_000 });

    const after = await getArticleById(articleId);
    expect(after, 'the row was deleted rather than unpublished').not.toBeNull();
    expect(after?.status).toBe('DRAFT');
    expect(after?.slug).toBe(published?.slug);
    // `publishedAt` is retained deliberately: clearing it would un-freeze the
    // slug, and a republish would mint a new URL for an article people already
    // hold links to.
    expect(after?.publishedAt?.toISOString()).toBe(published?.publishedAt?.toISOString());
    expect(after?.bodyText).toBe(published?.bodyText);
  });

  test('an unpublished article leaves the home feed', async ({ page }) => {
    test.skip(!hasHomeFeed(), WAITING_ON_FEED);

    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    const slug = (await getArticleById(articleId))?.slug ?? '';
    await page.goto('/');
    await expect(page.locator(`a[href="/article/${slug}"]`)).toHaveCount(1);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });
    await page.getByTestId('unpublish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Draft', { timeout: 15_000 });

    await page.goto('/');
    await expect(page.locator(`a[href="/article/${slug}"]`)).toHaveCount(0);
  });

  test('an unpublished article leaves the FTS index', async ({ page }) => {
    const armed = await hasFtsTriggers();
    test.skip(!armed, WAITING_ON_FTS);

    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    const inIndex = async (): Promise<number> => {
      const rows = await getDb().$queryRawUnsafe<Array<{ n: bigint | number }>>(
        "SELECT COUNT(*) AS n FROM article_fts WHERE article_fts MATCH 'fifty'",
      );
      return Number(rows[0]?.n ?? 0);
    };

    expect(await inIndex()).toBeGreaterThan(0);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });
    await page.getByTestId('unpublish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Draft', { timeout: 15_000 });

    expect(await inIndex()).toBe(0);
    // Still a row, though — the criterion asks for both halves at once.
    expect(await getArticleById(articleId)).not.toBeNull();
  });
});
