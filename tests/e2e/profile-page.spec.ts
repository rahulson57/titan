/**
 * `/@[handle]` — the public author profile, in a real browser (SPEC-010).
 *
 * Six sealed criteria land here:
 *
 *   - `/@<handle>` for a seeded author returns HTTP 200 and renders the avatar,
 *     display name, bio, follower count and published-article list.
 *   - An unknown handle returns HTTP 404 (not 500).
 *   - The Drafts and Bookmarks tabs are absent from the DOM for a non-owner and
 *     for an anonymous visitor, and present for the owner.
 *   - Viewing one's own profile renders an `Edit profile` link and no Follow button.
 *   - Every rendered social link carries `rel` containing `nofollow`, `noopener`
 *     and `noreferrer` and `target="_blank"`.
 *   - A profile with no `coverPath` renders the gradient placeholder element and
 *     issues zero failed image requests.
 *
 * ── Why the fixture has a draft AND a published article ───────────────────
 * "The Drafts tab is absent for a non-owner" is unfalsifiable against an author
 * with no drafts: the tab would be missing either way and the assertion would
 * pass against a page that had never implemented the rule. The owner therefore
 * has one of each, and the owner-side assertion checks the draft is actually
 * *reachable and populated* — not merely that a tab exists.
 *
 * ── Why the handles are generated rather than taken from the seed ─────────
 * The seed corpus has one predictable handle (`demo`) and the rest are
 * `${first}_${index}` — resolvable, but shared with every other suite that
 * runs against the same development database. A suite that mutated a seeded
 * author's socials would change what a different suite reads. Every user here
 * is created by this file and deleted in `afterAll`, and the cascade takes
 * their articles, bookmarks and sessions with them.
 *
 * ── On reading the development database ───────────────────────────────────
 * Same posture as `bookmarks-page.spec.ts`: the thing under test IS the dev
 * server, which has one database, and this suite observes and seeds it through
 * `lib/db/` — never by constructing a Prisma client of its own, which
 * `tests/unit/db-boundary.test.ts` forbids and which would run with
 * `foreign_keys` OFF, silently disabling the cascade the cleanup relies on.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { hashPassword } from '../../lib/auth/password';
import { disconnectDb } from '../../lib/db/client';
import { createArticle, publishArticle } from '../../lib/db/articles';
import { follow, toggleBookmark } from '../../lib/db/social';
import { createUser, deleteUser, findUserByEmail, updateUser } from '../../lib/db/users';

/** Long, unremarkable, and deliberately not on the 200-entry denylist. */
const PASSWORD = 'a quiet afternoon of reading';

/** Fixed instant, so the fixture's order is a property of the fixture. */
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

let seq = 0;
function freshAccount(prefix: string) {
  const stamp = `${Date.now().toString(36)}${seq++}`;
  return {
    email: `${prefix}-${stamp}@titan.local`,
    password: PASSWORD,
    name: 'Ada Lovelace',
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

function body(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Watch for image requests that failed.
 *
 * SPEC-010's criterion is "issues zero failed image requests", and the trap it
 * exists for is `<img src="">`: a browser resolves the empty string against
 * the current document and re-requests the page itself, which is a failed
 * image load that looks like nothing at all on screen. Both channels are
 * listened to — `requestfailed` for a request that never completed, and any
 * response at 400 or above for one that completed with an error status.
 */
function watchImageFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'image') failures.push(`failed: ${request.url()}`);
  });
  page.on('response', (response) => {
    if (response.request().resourceType() === 'image' && response.status() >= 400) {
      failures.push(`${response.status()}: ${response.url()}`);
    }
  });
  return failures;
}

test.describe.configure({ mode: 'serial' });

test.describe('SPEC-010 — the public profile at /@handle', () => {
  const owner = freshAccount('pfown');
  const stranger = freshAccount('pfstr');
  let ownerId = '';
  let strangerId = '';
  let publishedTitle = '';
  let draftTitle = '';
  let bookmarkedTitle = '';

  test.beforeAll(async ({ browser }) => {
    // The owner signs up through the UI, so their session is a real one.
    const page = await browser.newPage();
    await signUp(page, owner);
    await page.close();

    const ownerRow = await findUserByEmail(owner.email);
    if (!ownerRow) throw new Error('sign-up did not create the owner');
    ownerId = ownerRow.id;

    // A bio and all three socials, so the header and link assertions have
    // something real to read. `avatarPath` is deliberately left null: this
    // profile is also the "no cover, zero failed image requests" fixture, and
    // pointing either image at a file that does not exist on disk would be the
    // exact failure that criterion forbids. The uploaded-image path is covered
    // end to end in `profile-settings.spec.ts`, which uploads a real file.
    await updateUser(ownerId, {
      bio: 'Writes about engines, and about the people who tend them.',
      socials: {
        twitter: 'ada_dev',
        github: 'ada-dev',
        website: 'https://ada.example/',
      },
    });

    // A stranger, who follows the owner. The follower count must be a live
    // COUNT(*) rather than 0 for the assertion to distinguish a real query
    // from a hard-coded zero.
    const strangerRow = await createUser({
      email: stranger.email,
      passwordHash: await hashPassword(stranger.password),
      handle: stranger.handle,
      name: 'Grace Hopper',
      createdAt: EPOCH,
    });
    createdEmails.push(stranger.email);
    strangerId = strangerRow.id;
    await follow(strangerId, ownerId, EPOCH);

    // One published article, one draft. Both are needed: see the header on why
    // an author with no drafts cannot falsify the Drafts-tab rule.
    publishedTitle = `Published story ${Date.now().toString(36)}`;
    const published = await createArticle({
      authorId: ownerId,
      title: publishedTitle,
      bodyJson: body(
        'A published story with enough prose for the card to derive a reading time and an excerpt.',
      ),
      bodyHtml: '<p>A published story.</p>',
      status: 'PUBLISHED',
      now: EPOCH,
    });
    await publishArticle(published.id, EPOCH);

    draftTitle = `Unfinished draft ${Date.now().toString(36)}`;
    await createArticle({
      authorId: ownerId,
      title: draftTitle,
      bodyJson: body('A draft nobody but its author may see, with a sentence of prose in it.'),
      bodyHtml: '<p>A draft.</p>',
      status: 'DRAFT',
      now: EPOCH,
    });

    // Something for the owner's Bookmarks tab, written by someone else so the
    // byline join is exercised rather than the degenerate self-authored case.
    bookmarkedTitle = `Saved by the owner ${Date.now().toString(36)}`;
    const saved = await createArticle({
      authorId: strangerId,
      title: bookmarkedTitle,
      bodyJson: body('A story the profile owner saved, by an author who is not them.'),
      bodyHtml: '<p>Saved.</p>',
      status: 'PUBLISHED',
      now: EPOCH,
    });
    await publishArticle(saved.id, EPOCH);
    await toggleBookmark(ownerId, saved.id, EPOCH);
  });

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  async function signInAsOwner(page: Page) {
    await page.goto('/signin');
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL('/');
  }

  /**
   * Can a `notFound()` thrown from inside a page set a 404 status in this tree?
   *
   * Measured against `/editor/[id]`, which is TASK-006's page, calls
   * `notFound()` for an unknown id, and is named in SPEC-011's route table so
   * it will not quietly disappear. Deliberately NOT measured against this
   * slice's own route: the point of the probe is to distinguish "the platform
   * cannot answer 404 from a page at all" from "this route gets it wrong", and
   * a probe of the route under test could not tell those apart.
   *
   * `/editor` is a protected prefix, so the probe signs in first — an
   * anonymous request would be redirected by the middleware and would measure
   * the redirect rather than the not-found path.
   */
  async function pageThrownNotFoundCanSet404(browser: Browser): Promise<boolean> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signInAsOwner(page);
      const response = await page.goto('/editor/no_such_article_id_probe');
      return (response?.status() ?? 0) === 404;
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // Criterion: 200, and the header renders
  // -------------------------------------------------------------------------

  test('renders the avatar, name, bio, follower count and published list', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const response = await page.goto(`/@${owner.handle}`);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('profile-name')).toHaveText(owner.name);
    await expect(page.getByTestId('profile-handle')).toHaveText(`@${owner.handle}`);
    await expect(page.getByTestId('profile-bio')).toContainText('Writes about engines');
    await expect(page.getByTestId('profile-avatar')).toBeVisible();

    // The count is asserted as a NUMBER via the data attribute as well as the
    // rendered sentence: "1 follower" could be produced by a hard-coded string,
    // and the attribute is what a regression in the COUNT(*) would move.
    await expect(page.getByTestId('profile-follower-count')).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('profile-follower-count')).toContainText('1 follower');
    await expect(page.getByTestId('profile-published-count')).toHaveAttribute('data-count', '1');

    // The published list, and only it: the draft must not be on a public page.
    await expect(page.getByTestId('profile-feed')).toContainText(publishedTitle);
    await expect(page.getByTestId('profile-feed')).not.toContainText(draftTitle);

    await context.close();
  });

  // -------------------------------------------------------------------------
  // Criterion: an unknown handle is 404, not 500
  // -------------------------------------------------------------------------

  test('an unknown handle answers not-found rather than a server error', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const response = await page.goto('/@no_such_person_here');
    const status = response?.status() ?? 0;

    // The half that holds today, unconditionally, and is the half that matters
    // most: a 500 on a guessable public URL is the failure this criterion
    // exists to prevent. It is also the half that would break if the root
    // dynamic segment's guard, or `findUserByHandle`, ever threw.
    expect(status, 'an unknown handle must not be a server error').toBeLessThan(500);
    // And it is genuinely the not-found page, not a blank profile shell — a
    // status assertion alone would pass against a page rendering an empty
    // header for a user who does not exist.
    await expect(page.getByTestId('profile-page')).toHaveCount(0);

    await context.close();

    // The strict status, gated on a CAPABILITY PROBE rather than on a filename.
    //
    // A root `app/loading.tsx` makes Next stream every page render, and a
    // streamed response has already committed HTTP 200 by the time a
    // page-thrown `notFound()` is reached — the status cannot be retracted. So
    // on a tree that still has that file, no page in the app can answer 404
    // from `notFound()`, and this criterion is unsatisfiable through no fault
    // of this route. Its deletion is authorized under DEC-047 and lands with
    // TASK-009.
    //
    // The obvious guard is `existsSync('app/loading.tsx')`, and it is the wrong
    // one. It is a proxy for the behaviour, and a proxy for a file that is
    // *authorized to be deleted* drifts from what it stands for: it reports
    // "waiting on TASK-009" on a tree where the file is already gone, and
    // TASK-018's per-segment loading files could re-disarm it by accident. The
    // failure mode is a silent skip, which is the exact class that has produced
    // three green-and-vacuous tests in this project today.
    //
    // So the guard measures the property itself, on a route this suite does not
    // own: can ANY page-thrown `notFound()` set a 404 in this tree? If not, the
    // platform is the blocker and this assertion waits. If it can, this route
    // must too, and no excuse is available.
    const capable = await pageThrownNotFoundCanSet404(browser);
    test.skip(
      !capable,
      'waiting on TASK-009 (DEC-047): a page-thrown notFound() cannot set a 404 status ' +
        'in this tree, because the root app/loading.tsx streams every response',
    );
    expect(status).toBe(404);
  });

  test('a segment that is not a handle reference is not treated as a profile', async ({
    browser,
  }) => {
    // `app/[handle]/` is the catch-all for every unmatched single-segment URL
    // (DEC-049). Without the leading-`@` guard, `/nonexistent` would become a
    // profile lookup and this page would silently be the app's 404 handler.
    const context = await browser.newContext();
    const page = await context.newPage();

    const response = await page.goto('/definitely-not-a-route');
    expect(response?.status() ?? 0).toBeLessThan(500);
    await expect(page.getByTestId('profile-page')).toHaveCount(0);

    await context.close();
  });

  // -------------------------------------------------------------------------
  // Criterion: owner-only tabs
  // -------------------------------------------------------------------------

  test('hides the Drafts and Bookmarks tabs from an anonymous visitor', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/@${owner.handle}`);

    await expect(page.getByTestId('profile-tab-published')).toBeVisible();
    // "Absent from the DOM", not hidden: `toHaveCount(0)` is the assertion the
    // criterion asks for. `toBeHidden()` would pass on a tab that was present
    // in the source, in the accessibility tree of anything ignoring CSS, and
    // in view-source for anyone curious about whether this author has drafts.
    await expect(page.getByTestId('profile-tab-drafts')).toHaveCount(0);
    await expect(page.getByTestId('profile-tab-bookmarks')).toHaveCount(0);

    await context.close();
  });

  test('hides them from a signed-in non-owner too', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, freshAccount('pfoth'));

    await page.goto(`/@${owner.handle}`);
    await expect(page.getByTestId('profile-tab-published')).toBeVisible();
    await expect(page.getByTestId('profile-tab-drafts')).toHaveCount(0);
    await expect(page.getByTestId('profile-tab-bookmarks')).toHaveCount(0);

    await context.close();
  });

  test('serves the published list to a stranger who asks for ?tab=drafts', async ({ browser }) => {
    // Absence from the DOM is a disclosure control, not an authorization one.
    // Anyone can type the query parameter, and this is the assertion that the
    // rows themselves are protected rather than just the link to them.
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`/@${owner.handle}?tab=drafts`);
    await expect(page.getByTestId('profile-page')).toHaveAttribute('data-tab', 'published');
    await expect(page.locator('body')).not.toContainText(draftTitle);

    await context.close();
  });

  test('shows both owner-only tabs to the owner, populated', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Sign in as the owner. The account was created through the UI in
    // `beforeAll`, in a context that has since been closed.
    await signInAsOwner(page);

    await page.goto(`/@${owner.handle}`);
    await expect(page.getByTestId('profile-tab-drafts')).toBeVisible();
    await expect(page.getByTestId('profile-tab-bookmarks')).toBeVisible();

    // And the tabs actually resolve. A visible tab that led to an empty list
    // would satisfy the criterion's letter and none of its point.
    await page.getByTestId('profile-tab-drafts').click();
    await expect(page.getByTestId('profile-page')).toHaveAttribute('data-tab', 'drafts');
    await expect(page.getByTestId('profile-feed')).toContainText(draftTitle);

    await page.getByTestId('profile-tab-bookmarks').click();
    await expect(page.getByTestId('profile-page')).toHaveAttribute('data-tab', 'bookmarks');
    await expect(page.getByTestId('profile-feed')).toContainText(bookmarkedTitle);

    // Criterion: own profile shows Edit profile and never a Follow button.
    await expect(page.getByTestId('profile-edit-link')).toBeVisible();
    await expect(page.getByTestId('profile-edit-link')).toHaveAttribute(
      'href',
      '/settings/profile',
    );
    await expect(page.getByRole('button', { name: /^follow(ing)?$/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^follow(ing)?$/i })).toHaveCount(0);

    await context.close();
  });

  // -------------------------------------------------------------------------
  // Criterion: outbound link hygiene
  // -------------------------------------------------------------------------

  test('gives every social link rel=nofollow noopener noreferrer and target=_blank', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/@${owner.handle}`);

    const links = page.getByTestId('profile-social-link');
    // Three links, because the fixture set three. Asserting the count first is
    // what stops this test passing vacuously against a page that rendered none
    // — `for (const link of [])` checks nothing and reports success.
    await expect(links).toHaveCount(3);

    for (const link of await links.all()) {
      const rel = (await link.getAttribute('rel')) ?? '';
      const tokens = rel.split(/\s+/);
      expect(tokens, `rel="${rel}"`).toContain('nofollow');
      expect(tokens, `rel="${rel}"`).toContain('noopener');
      expect(tokens, `rel="${rel}"`).toContain('noreferrer');
      await expect(link).toHaveAttribute('target', '_blank');
      // And the href is one of the two schemes SPEC-010 permits. A stored
      // `javascript:` value is refused at write time AND at render time, and
      // this is the browser-level check on the second half.
      const href = (await link.getAttribute('href')) ?? '';
      expect(href).toMatch(/^https?:\/\//);
    }

    // The documented rendering: a bare handle becomes a platform URL.
    await expect(page.locator('[data-social="twitter"]')).toHaveAttribute(
      'href',
      'https://x.com/ada_dev',
    );
    await expect(page.locator('[data-social="github"]')).toHaveAttribute(
      'href',
      'https://github.com/ada-dev',
    );

    await context.close();
  });

  // -------------------------------------------------------------------------
  // Criterion: the cover placeholder
  // -------------------------------------------------------------------------

  test('renders the gradient placeholder and requests no broken images', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const failures = watchImageFailures(page);

    await page.goto(`/@${owner.handle}`, { waitUntil: 'networkidle' });

    await expect(page.getByTestId('profile-cover-placeholder')).toBeVisible();
    // No cover image element at all — not a hidden one, and above all not an
    // `<img src="">`, which re-requests the document itself.
    await expect(page.getByTestId('profile-cover')).toHaveCount(0);
    expect(await page.locator('img[src=""]').count()).toBe(0);

    expect(failures, `failed image requests: ${failures.join(', ')}`).toEqual([]);

    await context.close();
  });
});
