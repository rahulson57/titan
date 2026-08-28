/**
 * Autosave, in the browser (SPEC-007).
 *
 * Two sealed criteria:
 *
 * > Typing in the editor then idling 2s issues exactly ONE `saveDraft` call and
 * > the indicator reads `Saved`.
 *
 * > Typing continuously for 35s issues at least one save before the 30s ceiling
 * > elapses.
 *
 * ── What this suite adds over `tests/unit/editor-conflict.test.ts` ─────────
 * The unit suite drives the same state machine through an injected clock and
 * proves the debounce and the ceiling in under a millisecond. It cannot prove
 * the two things that only exist once the editor is real: that keystrokes
 * actually reach the scheduler, and that ONE scheduler tick produces ONE
 * network call. A debounce that is correct in isolation and mounted twice — a
 * `useEffect` without a dependency array, a component that re-creates its
 * scheduler on every render — fires N times per idle period and passes every
 * unit test. That is what "exactly one" is here to catch, so the count is taken
 * from the wire.
 *
 * ── Counting Server Action calls ──────────────────────────────────────────
 * A Next Server Action is a POST to the current URL carrying a `Next-Action`
 * header naming the action's generated id. Requests are counted by that header
 * rather than by URL, because RSC navigations and the dev-server's own traffic
 * POST to the same paths and would otherwise be counted as saves.
 */

import { expect, test, type Page, type Request } from '@playwright/test';

import { appIsBootable } from '../../playwright.config';
import { disconnectDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';
import { createArticle, getArticleById } from '../../lib/db/articles';
import { AUTOSAVE_MAX_INTERVAL_MS } from '../../lib/content/autosave';

const createdEmails: string[] = [];

/** A fresh identity per test — the same shape `auth.spec.ts` uses. */
function freshAccount() {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return {
    name: 'Autosave Author',
    handle: `auto_${stamp}`.slice(0, 24),
    email: `auto-${stamp}@titan.local`,
    password: 'a quiet afternoon of reading',
  };
}

async function signUp(page: Page, account: ReturnType<typeof freshAccount>) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL('/');
}

/**
 * A draft owned by the signed-in author, created through the repository.
 *
 * Through `lib/db/` rather than through the editor's own first save, and
 * deliberately: the criterion is about `saveDraft`, and the first save at
 * `/editor/new` is `createDraft` — a different action. Starting from a row that
 * already exists makes every save in the test the one being measured.
 */
async function seedDraft(email: string): Promise<string> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`sign-up did not create ${email}`);
  const article = await createArticle({
    authorId: user.id,
    title: 'A draft to autosave',
    bodyJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    bodyHtml: '<p></p>',
  });
  return article.id;
}

/** Every Server Action POST the page makes, with the time it was issued. */
function recordActionCalls(page: Page): { calls: Array<{ at: number }>; startedAt: number } {
  const calls: Array<{ at: number }> = [];
  const startedAt = Date.now();
  page.on('request', (request: Request) => {
    if (request.method() !== 'POST') return;
    const headers = request.headers();
    if (headers['next-action']) calls.push({ at: Date.now() });
  });
  return { calls, startedAt };
}

test.describe('SPEC-007 — autosave', () => {
  test.skip(!appIsBootable(), 'no bootable app yet');

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('typing then idling 2s issues exactly one saveDraft and the indicator reads Saved', async ({
    page,
  }) => {
    const account = freshAccount();
    createdEmails.push(account.email);
    await signUp(page, account);
    const articleId = await seedDraft(account.email);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });

    const body = page.getByTestId('editor-body');
    await expect(body).toBeVisible();
    const indicator = page.getByTestId('save-indicator');
    await expect(indicator).toHaveText('Saved');

    const { calls } = recordActionCalls(page);

    await body.click();
    // Typed with a delay well inside the 2s debounce, so all of it belongs to
    // one idle period. Twelve keystrokes must still be one save.
    await body.pressSequentially('twelve chars', { delay: 40 });

    await expect(indicator).toHaveText('Unsaved changes');

    // The debounce, plus room for the round trip. `toHaveText` polls, so this
    // is a deadline rather than a fixed wait.
    await expect(indicator).toHaveText('Saved', { timeout: 10_000 });

    // Settle: if a second save were going to be issued, this is when.
    await page.waitForTimeout(3_000);
    expect(
      calls.length,
      `expected exactly one saveDraft for one idle period, saw ${calls.length}. ` +
        'More than one usually means the scheduler is being re-created on every ' +
        'render, or the debounce is armed per keystroke without being cancelled.',
    ).toBe(1);

    const stored = await getArticleById(articleId);
    expect(stored?.bodyText).toContain('twelve chars');
    expect(stored?.version).toBe(2);
  });

  test('the indicator only ever shows one of the four strings the spec fixes', async ({ page }) => {
    const account = freshAccount();
    createdEmails.push(account.email);
    await signUp(page, account);
    const articleId = await seedDraft(account.email);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });

    const seen = new Set<string>();
    const indicator = page.getByTestId('save-indicator');

    seen.add((await indicator.textContent()) ?? '');
    await page.getByTestId('editor-body').click();
    await page.getByTestId('editor-body').pressSequentially('watching the label', { delay: 30 });
    seen.add((await indicator.textContent()) ?? '');
    await expect(indicator).toHaveText('Saved', { timeout: 10_000 });
    seen.add((await indicator.textContent()) ?? '');

    // The set is CLOSED by the spec ("one of exactly"). Asserting membership
    // rather than a specific sequence catches a stray "Saving" or "Saved ✓"
    // without pinning the order the states happen to occur in.
    for (const text of seen) {
      expect(['Saved', 'Saving…', 'Unsaved changes', 'Save failed — retry']).toContain(text);
    }
    expect(seen.has('Unsaved changes')).toBe(true);
  });

  test('typing continuously for 35s issues a save before the 30s ceiling', async ({ page }) => {
    // The slowest test in the slice, and it cannot be made faster without
    // measuring something else: the criterion is about wall-clock behaviour
    // under continuous typing, which is exactly the case a debounce alone never
    // satisfies. The unit suite covers the same edge against an injected clock;
    // this one covers it against a real editor and a real network.
    test.setTimeout(90_000);

    const account = freshAccount();
    createdEmails.push(account.email);
    await signUp(page, account);
    const articleId = await seedDraft(account.email);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });
    const body = page.getByTestId('editor-body');
    await body.click();

    const { calls } = recordActionCalls(page);
    const startedAt = Date.now();

    // 35 seconds of never pausing for the 2s debounce. Every keystroke re-arms
    // it, so a scheduler that only debounces saves nothing at all here.
    while (Date.now() - startedAt < 35_000) {
      await body.pressSequentially('typing ', { delay: 60 });
    }

    expect(calls.length, 'no save was issued during 35s of continuous typing').toBeGreaterThan(0);

    const firstSaveAfter = (calls[0]?.at ?? Number.POSITIVE_INFINITY) - startedAt;
    expect(
      firstSaveAfter,
      `the first save came ${firstSaveAfter}ms after typing began, past the ` +
        `${AUTOSAVE_MAX_INTERVAL_MS}ms ceiling. A debounce that is only ever re-armed ` +
        'never fires while the author keeps typing — the ceiling has to be able to pre-empt it.',
    ).toBeLessThan(AUTOSAVE_MAX_INTERVAL_MS);

    const stored = await getArticleById(articleId);
    expect(stored?.bodyText).toContain('typing');
  });

  test('Cmd/Ctrl+S saves immediately instead of waiting for the debounce', async ({ page }) => {
    const account = freshAccount();
    createdEmails.push(account.email);
    await signUp(page, account);
    const articleId = await seedDraft(account.email);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });
    const body = page.getByTestId('editor-body');
    await body.click();
    await body.pressSequentially('saved by hand', { delay: 20 });

    const { calls } = recordActionCalls(page);
    await page.keyboard.press('ControlOrMeta+s');

    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });
    // Polled, not read once: the indicator can still be showing the state the
    // page arrived in when the assertion first runs, so a single read races the
    // save. Same fix as the conflict-banner test below, same reason.
    await expect
      .poll(async () => (await getArticleById(articleId))?.bodyText ?? '', { timeout: 10_000 })
      .toContain('saved by hand');

    // And the armed debounce was cancelled, not merely pre-empted: without the
    // cancel the same document is written again two seconds later.
    await page.waitForTimeout(3_000);
    expect(calls.length).toBe(1);
  });

  test('a stale version shows the non-destructive conflict banner', async ({ page }) => {
    const account = freshAccount();
    createdEmails.push(account.email);
    await signUp(page, account);
    const articleId = await seedDraft(account.email);

    await page.goto(`/editor/${articleId}`, { waitUntil: 'networkidle' });
    const body = page.getByTestId('editor-body');
    await body.click();
    await body.pressSequentially('local edit', { delay: 20 });

    // Wait for the edit to reach the DATABASE, not merely for the indicator to
    // read `Saved`.
    //
    // `toHaveText('Saved')` alone cannot carry this precondition: a draft opened
    // from a saved row reads `Saved` because that is its honest state, and React
    // has not necessarily committed the `Unsaved changes` render by the time the
    // assertion first polls. So it can match the state the page ARRIVED in and
    // return while the first autosave is still in flight — after which the
    // simulated other-tab write below races it, and whichever lands second
    // wins. Polling the row waits for the write itself, which is the actual
    // precondition.
    //
    // ── The timeout is 30s, and the message is instrumented, deliberately ────
    // This test failed three acceptance-gate runs while passing locally in every
    // configuration tried: warm and cold `.next`, freshly seeded and reused
    // database, isolated and in the full suite. The gate reported the row's
    // `bodyText` still empty, i.e. the first save had simply not landed.
    //
    // Because the cause is not reproducible here, this does two things rather
    // than one. The longer budget removes "the gate box is slower than this one"
    // as an explanation — 30s is 15x the 2s debounce and still well inside the
    // 60s per-test timeout. And the failure message reports the indicator text
    // and the row's version, so if it fails again the artifact says WHICH of the
    // three possibilities happened: `Save failed — retry` (the request errored),
    // `Saving…` (still in flight), or `Saved` with an unchanged version (a 409).
    // The previous failure said only `Received string: ""`, which distinguishes
    // none of them.
    await expect
      .poll(
        async () => {
          const row = await getArticleById(articleId);
          const indicator = await page.getByTestId('save-indicator').textContent();
          return `${row?.bodyText ?? '<no row>'} | indicator=${indicator} | version=${row?.version}`;
        },
        {
          timeout: 30_000,
          message:
            'the first autosave never reached the database. The indicator and version above say ' +
            'which failure this was: "Save failed — retry" means the request errored, "Saving…" ' +
            'means it was still in flight, and "Saved" with an unchanged version means a 409.',
        },
      )
      .toContain('local edit');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });

    // Simulate the other tab: move the row on directly, so this page's
    // last-known version is now behind.
    const { updateArticle } = await import('../../lib/db/articles');
    await updateArticle(articleId, {
      bodyJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'from another tab' }] }] },
      bodyHtml: '<p>from another tab</p>',
    });
    const afterOtherTab = await getArticleById(articleId);

    await body.click();
    await body.pressSequentially(' and more', { delay: 20 });
    await page.keyboard.press('ControlOrMeta+s');

    await expect(page.getByTestId('conflict-banner')).toBeVisible({ timeout: 10_000 });

    // "Non-destructive" is the whole point, and it cuts both ways: the newer
    // server document is intact, and nothing the author typed here was thrown
    // away either.
    const stored = await getArticleById(articleId);
    expect(stored?.bodyText).toBe(afterOtherTab?.bodyText);
    expect(stored?.version).toBe(afterOtherTab?.version);
    await expect(body).toContainText('and more');
  });

  test('the first save at /editor/new creates the row and adopts its URL', async ({ page }) => {
    const account = freshAccount();
    createdEmails.push(account.email);
    await signUp(page, account);

    await page.goto('/editor/new', { waitUntil: 'networkidle' });

    // Nothing exists yet: the route deliberately does not write on GET.
    await expect(page).toHaveURL(/\/editor\/new$/);

    await page.getByTestId('article-title').fill('A brand new story');
    await page.getByTestId('editor-body').click();
    await page.getByTestId('editor-body').pressSequentially('First words.', { delay: 20 });

    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });

    // The URL moved to the new id WITHOUT a navigation, so a refresh lands on
    // the draft rather than on another blank document.
    await expect(page).toHaveURL(/\/editor\/[a-z0-9]{26}$/);

    const id = (await page.getByTestId('article-id').textContent())?.trim() ?? '';
    const created = await getArticleById(id);
    expect(created?.title).toBe('A brand new story');
    expect(created?.status).toBe('DRAFT');
    expect(created?.bodyText).toContain('First words.');
  });
});
