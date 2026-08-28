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
 *  - **"removes from the home feed"** — ARMED since TASK-007 (SPEC-008)
 *    landed the ranked feed. Guarded on the feed's own `data-testid` rather
 *    than on the absence of a placeholder, and the guard is itself under test
 *    at the bottom of this file. See TASK-022 for why that stopped being
 *    optional.
 *  - **"and from FTS results"** — UNCONDITIONAL as of TASK-023, and the guard
 *    it used to sit behind is deleted rather than repaired. Nothing in this
 *    slice writes the index, deliberately: the triggers key off
 *    `Article.status`, so publishing correctly here IS indexing. Writing the
 *    index by hand from `lib/content/publish.ts` would give the search corpus
 *    two authors that have to agree, and the failure mode is an article that is
 *    published but unfindable.
 *
 * The home-feed clause is therefore capability-guarded, with its real
 * assertions written out in full; it armed itself when SPEC-008 landed and
 * needed no edit to this file. This is the shape
 * `tests/e2e/draft-privacy.spec.ts` established and `tests/helpers/db.ts` calls
 * a capability probe.
 *
 * ── Amended by TASK-022 ───────────────────────────────────────────────────
 * The self-arming property above is only as good as what the guard is keyed
 * on, and the home-feed guard was keyed on the wrong thing — it disarmed
 * itself again, in silence, months after the slice it was waiting for had
 * landed. A guard now keys on the CONTRACT the test consumes, and a
 * guard-integrity test at the bottom of this file fails loudly if it is
 * disarmed while the thing it waits for is present. An armed-but-skipped test
 * that nobody can see skipping is indistinguishable from a test that does not
 * exist.
 *
 * ── Amended by TASK-023: the FTS guard is gone ────────────────────────────
 * `hasFtsTriggers()` asked whether anything maintained `article_fts` yet. The
 * triggers had existed since TASK-007, but `lib/search/fts.ts` installed them
 * LAZILY on the first call into the search module — so the answer depended on
 * whether a search had already run against this database file. Under
 * `npm test` (`vitest run && playwright test`) the unit suites always searched
 * first and the guard armed; running `playwright test` on THIS FILE alone left
 * it disarmed, and the test below silently did not run: 1 skipped in isolation
 * versus 0 in the gate, on one commit.
 *
 * That is not a capability the suite should wait on, it is a bootstrap order
 * this suite should not be able to observe. TASK-023 moved the DDL into
 * `prisma/migrations/20260828190000_fts_write_triggers/`, so the triggers now
 * exist in every database `prisma migrate deploy` has touched. The guard would
 * then be a predicate that can never be false — which is strictly worse than
 * no guard, because it looks like protection while asserting nothing. So it is
 * deleted, and the test runs the same way in the gate and in isolation.
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
 * The id the home feed publishes as its contract — and the id this suite
 * queries when it asserts a withdrawn article is gone from `/`.
 *
 * Named once, deliberately: the guard below and the assertion in the test must
 * agree about what "the home feed" is. A guard that arms on one identifier
 * while the test looks for another is how a suite goes green against a page it
 * never actually reached.
 */
const HOME_FEED_TESTID = 'home-feed';

/** `app/page.tsx` as it stands on disk, or `null` if it is not there at all. */
function homePageSource(): string | null {
  const page = join(REPO_ROOT, 'app', 'page.tsx');
  return existsSync(page) ? readFileSync(page, 'utf8') : null;
}

/**
 * ── Repaired by TASK-022 (operator-filed from the 18:42 audit) ─────────────
 *
 * True once a real home feed is built, checked POSITIVELY: does `app/page.tsx`
 * render the one thing the assertion below needs in order to be answerable at
 * all, `data-testid="home-feed"`?
 *
 * What it used to be, and why that failed. The predicate was
 * `!source.includes('PLACEHOLDER')` — "S01's boot placeholder is gone". It was
 * correct when written and it armed correctly when SPEC-008 landed. TASK-018
 * then added a loading skeleton containing `const PLACEHOLDER_ROWS`, and the
 * guard silently flipped back to false: from 16:31 the SPEC-007 withdrawal
 * test skipped, on a fully built feed, for a reason with nothing to do with
 * the feed. The two tasks share no file, so no reviewer of either diff could
 * have seen it — and the suite stayed green the whole time, because a test
 * that does not run cannot fail.
 *
 * The class matters more than the instance. A guard keyed on INCIDENTAL file
 * content is disarmed by any later edit that merely mentions the word. A guard
 * keyed on the CONTRACT the test consumes can only be disarmed by removing
 * that contract — a change this file should notice, and one the guard
 * integrity test at the bottom makes it notice loudly instead of quietly.
 *
 * `source` is a parameter so the predicate can be exercised against mutated
 * text without touching the repo — see 'the home-feed guard is armed today,
 * and can still fail'.
 */
function hasHomeFeed(source: string | null = homePageSource()): boolean {
  return source !== null && source.includes(`data-testid="${HOME_FEED_TESTID}"`);
}

const WAITING_ON_FEED =
  `app/page.tsx does not render data-testid="${HOME_FEED_TESTID}", so there is no home feed for ` +
  'a withdrawn article to disappear from. This guard is ARMED as of TASK-022 — if you are reading ' +
  'this as a live skip reason, the feed contract was removed or renamed, and the guard-integrity ' +
  'test at the bottom of this file will have gone red alongside it. Fix the feed or update ' +
  'HOME_FEED_TESTID; do not delete either check.';

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

  /**
   * ── Amended by TASK-007 (SPEC-008), on the operator's ruling in MSG-2427 ──
   *
   * This test was correct when it was written and was made unsatisfiable by a
   * later slice — a spec-evolution artifact, not an error by anyone. It is
   * recorded here rather than in a commit message because the next person to
   * read it will otherwise re-introduce the original assertion.
   *
   * It used to publish an article and require it on **page 1 of `/`**. `/` was
   * S01's placeholder then, so "the home feed" could only mean "whatever `/`
   * lists". SPEC-008 then made `/` a RANKED feed, and a ranked feed makes no
   * placement promise to new work:
   *
   *     score = ln(1 + clapTotal) + 2.0 * exp(-ageHours / 72.0)
   *
   * The recency term cannot exceed `2.0` at any freshness, so a brand-new
   * unclapped article scores exactly 2.000. Measured against the seed corpus,
   * page 1 cuts at 5.328 (its twentieth article has 205 claps) — a new article
   * would need ~28 claps to appear there. Unreachable by construction, not
   * flaky.
   *
   * So presence is now asserted on `/tag/craft`, which SPEC-008 defines as
   * "published articles with that tag, **newest first**" — where a
   * just-published article is guaranteed to be row one. The article is already
   * tagged `craft` two lines below; nothing about the fixture changed.
   *
   * The absence half got STRONGER rather than weaker, which is the point.
   * `/` alone was vacuous: the article was never on page 1, so that assertion
   * passed whether or not unpublishing did anything at all. Checking the tag
   * page — where it demonstrably WAS present a moment earlier — is what
   * actually catches an unpublish that fails to withdraw the article.
   */
  test('an unpublished article leaves the tag page and the home feed', async ({ page }) => {
    test.skip(!hasHomeFeed(), WAITING_ON_FEED);

    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    const slug = (await getArticleById(articleId))?.slug ?? '';
    const link = `a[href="/article/${slug}"]`;

    await page.goto('/tag/craft');
    await expect(page.locator(link)).toHaveCount(1);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });
    await page.getByTestId('unpublish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Draft', { timeout: 15_000 });

    await page.goto('/tag/craft');
    // Prove we are looking at the tag page before concluding the article is not
    // on it. `toHaveCount(0)` is satisfied by a 404, an error boundary or a
    // redirect exactly as happily as by a correct withdrawal — the absence half
    // of this criterion is only worth anything if the page is known to be the
    // right one. The `toHaveCount(1)` above establishes that for the published
    // case; nothing established it for the withdrawn one.
    await expect(page.getByTestId('tag-page')).toBeVisible();
    await expect(page.locator(link)).toHaveCount(0);

    await page.goto('/');
    // The positive check the guard is now keyed on, asserted at runtime as well
    // as statically: the guard reads `app/page.tsx`, and the only thing that
    // proves the built page agrees with its source is querying the id here.
    await expect(page.getByTestId(HOME_FEED_TESTID)).toBeVisible();
    await expect(page.locator(link)).toHaveCount(0);
  });

  test('an unpublished article leaves the FTS index', async ({ page }) => {
    // No capability guard: the write triggers are created by
    // prisma/migrations/20260828190000_fts_write_triggers, so every database
    // this suite can reach has them. See the header for what was here before.
    const articleId = await openDraft(page, GOOD_BODY);
    await addTag(page, 'craft');
    await page.getByTestId('publish-button').click();
    await expect(page.getByTestId('article-status')).toHaveText('Published', { timeout: 15_000 });

    /**
     * Is THIS article in the index?
     *
     * Amended by TASK-007 alongside the test above, and for a related reason:
     * this probe used to count every indexed article matching `fifty`, and
     * `fifty` comes from `GOOD_BODY`, which every fixture in this file shares.
     * Two earlier tests — "a valid draft publishes" and "an edit and a
     * republish" — deliberately END with their article PUBLISHED, so by the
     * time this one runs there are already two other indexed articles
     * containing the word. `toBe(0)` could then never hold, however perfectly
     * the triggers behaved.
     *
     * It went unnoticed because the whole test was skipped until SPEC-008's
     * triggers landed: the capability guard TASK-023 has since deleted read
     * false, so the assertion had never once executed. Arming it is what
     * exposed it.
     *
     * Narrowing the count to `a."id" = articleId` asks the question the test's
     * own name asks. It is also strictly stronger than a global count: a
     * global count of zero can be reached by an over-eager trigger that empties
     * the index entirely, and this cannot.
     */
    const inIndex = async (): Promise<number> => {
      const rows = await getDb().$queryRawUnsafe<Array<{ n: bigint | number }>>(
        `SELECT COUNT(*) AS n
           FROM article_fts
           JOIN "Article" a ON a."rowid" = article_fts."rowid"
          WHERE article_fts MATCH 'fifty' AND a."id" = ?`,
        articleId,
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

/**
 * ── The guard, under test (TASK-022) ──────────────────────────────────────
 *
 * A skip guard is code, and nothing in this repo tested one until now. The
 * home-feed guard above was wrong for over two hours and the suite stayed
 * green throughout, because the only thing it broke was a test's ability to
 * run — and an unrun test reports nothing at all. These assertions are the
 * smallest thing that would have caught it:
 *
 *   1. it is ARMED right now. This is the backstop. If the feed's contract is
 *      renamed or deleted, THIS goes red, instead of the withdrawal test going
 *      quiet. Making disarmament noisy is the entire point.
 *   2. it CAN still fail. A predicate that returns true for every input would
 *      satisfy (1) forever while guarding nothing, which is the failure mode
 *      (1) alone cannot distinguish from success.
 *   3. it is IMMUNE to the collision that broke it. The old predicate is
 *      written out beside the new one and both are run against the same
 *      synthetic source, so the regression is demonstrated rather than
 *      asserted — a reader can see the old one return the wrong answer.
 *
 * Fixtures are synthetic, not the real `app/page.tsx`, everywhere except (1).
 * Pinning a mutation proof to today's incidental file contents would recreate
 * the bug being fixed, one file over.
 *
 * Deliberately NOT behind `appIsBootable()`: these are pure assertions about
 * text, they need no browser and no database, and a guard-integrity check that
 * can itself be skipped is self-defeating.
 */
test.describe('SPEC-007 — the home-feed guard is itself load-bearing', () => {
  test('the home-feed guard is armed today, and can still fail', () => {
    const source = homePageSource();
    if (source === null) {
      throw new Error('app/page.tsx is absent — there is no home feed contract to guard on.');
    }

    // (1) ARMED. The assertion that goes red in place of a silent skip.
    expect(
      hasHomeFeed(source),
      `app/page.tsx no longer renders data-testid="${HOME_FEED_TESTID}", so the withdrawal test ` +
        'in this file would skip rather than fail. Restore the id on the feed container, or ' +
        'update HOME_FEED_TESTID to follow it — do not delete this check.',
    ).toBe(true);

    // (2) CAN FAIL — three distinct ways the contract can actually break.
    expect(hasHomeFeed(null), 'no app/page.tsx at all must not arm the guard').toBe(false);
    expect(
      hasHomeFeed('export default function Home() {\n  return <main />;\n}\n'),
      'a home page with no feed container must not arm the guard',
    ).toBe(false);
    expect(
      hasHomeFeed(source.replace(`data-testid="${HOME_FEED_TESTID}"`, 'data-testid="feed"')),
      'renaming the id out from under the test must not arm the guard',
    ).toBe(false);

    // (3) THE COLLISION, replayed. `legacyGuard` is the predicate this task
    // removed, verbatim; `feedWithSkeleton` is the shape TASK-018 introduced —
    // a real, complete feed that also happens to contain the word.
    const legacyGuard = (text: string) => !text.includes('PLACEHOLDER');
    const feedWithSkeleton =
      'const PLACEHOLDER_ROWS = [0, 1, 2];\n' +
      'export default function Home() {\n' +
      `  return <main data-testid="${HOME_FEED_TESTID}" />;\n` +
      '}\n';

    expect(
      legacyGuard(feedWithSkeleton),
      'this is the defect: the old guard reads a built feed as "not built yet"',
    ).toBe(false);
    expect(
      hasHomeFeed(feedWithSkeleton),
      'the repaired guard must stay armed through an unrelated PLACEHOLDER mention',
    ).toBe(true);

    // The two predicates must not merely differ here — they must differ FOR
    // THIS REASON. Strip the incidental mention and the old one arms again,
    // which is what makes the collision the cause rather than a coincidence.
    expect(legacyGuard(feedWithSkeleton.replace('PLACEHOLDER_ROWS', 'SKELETON_ROWS'))).toBe(true);
  });
});
