/**
 * `/settings/profile` — the owner-only editor, in a real browser (SPEC-010).
 *
 * Two sealed criteria land here:
 *
 *   - Uploading a new avatar updates `User.avatarPath` and the new image is
 *     visible on `/@<handle>` after reload.
 *   - An anonymous request to `/settings/profile` redirects to
 *     `/signin?next=/settings/profile`.
 *
 * ── Why the avatar test uploads a real JPEG ───────────────────────────────
 * The criterion is end to end by construction: a *file* has to reach
 * `/api/upload`, be decoded, re-encoded as WebP and written to disk under the
 * session user's own id, and the resulting path has to survive a Server Action
 * and come back out of the database as an `<img src>` on another page. A
 * fixture that stubbed any of that would leave the joins between the pieces —
 * which is where this can actually break — untested.
 *
 * So the fixture is generated with `sharp` at test time rather than committed:
 * a real JPEG of deterministic noise. Noise rather than a gradient because a
 * gradient compresses to almost nothing and would not exercise the decoder on
 * anything resembling a photograph.
 *
 * ── Why "no write" is checked against the row, not the message ────────────
 * Three of SPEC-010's criteria say "rejected with a field-level error **and no
 * write**". A test that only asserted the message would pass against a form
 * that rendered the error *after* updating the row. Every rejection case below
 * reads the row back through `lib/db/users.ts`.
 *
 * ── Why the save is awaited on `data-saved-at` and not on text ────────────
 * `toHaveText('Saved')` is the precondition race that cost this project a gate
 * run on TASK-006: the indicator can already read the arrival state when
 * Playwright first polls, so the assertion returns while the request is still
 * in flight. `data-saved-at` appears only when an action has RETURNED a
 * successful save, so it cannot be true before one has completed — and the
 * assertion that it is absent on arrival keeps a future change from seeding it
 * from the server row and quietly restoring the race.
 */

import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

import { disconnectDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

/** Long, unremarkable, and deliberately not on the 200-entry denylist. */
const PASSWORD = 'a quiet afternoon of reading';

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

/**
 * A small JPEG of deterministic noise.
 *
 * The LCG rather than `randomBytes` so a failure is reproducible from the file
 * alone — the same choice `tests/unit/upload-avatar.test.ts` makes and for the
 * same reason.
 */
async function noiseJpeg(width = 320, height = 320): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x2f6e2b1;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = (state >>> 24) & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90, mozjpeg: false })
    .toBuffer();
}

/**
 * Open the settings page and wait until the form is actually interactive.
 *
 * "Visible" is not "ready". The form's inputs are controlled by React state
 * and its submit is a Server Action, so anything typed or clicked before
 * hydration is either discarded outright (the file picker, whose entire job is
 * in `onChange`) or overwritten when React attaches and renders its own state.
 * Acting on `visible` produces a test that passes on a quiet machine and fails
 * under load — the shape of flakiness SPEC-002 refuses ("a flaky pass is a
 * failure").
 *
 * The uploader's file input is server-rendered `disabled` and enabled in an
 * effect, which is a genuine fix for a genuine user-facing window rather than
 * a hook added for tests — so "enabled" is a truthful readiness signal, and it
 * is the one thing on the page that can carry it without inventing an
 * attribute.
 */
async function gotoSettings(page: Page) {
  await page.goto('/settings/profile');
  await expect(page.getByTestId('profile-form')).toBeVisible();
  await expect(page.getByTestId('avatar-uploader-input')).toBeEnabled();
}

/**
 * Submit the form and wait for the action to have RETURNED a successful save.
 *
 * `data-saved-at` is written from the action's own result, so it cannot be
 * present while a request is in flight and a 400 leaves it absent. Its absence
 * is asserted first: without that, a future change that seeded the attribute
 * from the server row would turn every one of these waits back into the race
 * this helper exists to remove, silently.
 */
async function saveAndExpectLanded(page: Page) {
  const form = page.getByTestId('profile-form');
  await expect(form).not.toHaveAttribute('data-saved-at', /.+/);
  await page.getByTestId('profile-save').click();
  await expect(form).toHaveAttribute('data-saved-at', /.+/);
}

/** Submit and wait for a rejection, without waiting on any particular field. */
async function saveAndExpectRejected(page: Page) {
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-form')).toHaveAttribute('data-status', '400');
}

test.describe.configure({ mode: 'serial' });

test.describe('SPEC-010 — /settings/profile', () => {
  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  // -------------------------------------------------------------------------
  // Criterion: the anonymous redirect
  // -------------------------------------------------------------------------

  test('an anonymous request redirects to /signin?next=/settings/profile', async ({ browser }) => {
    // A fresh context: no cookie at all, which is the case the middleware
    // answers before a page is ever rendered.
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/signin\?next=%2Fsettings%2Fprofile/);
    // And the destination is usable. A redirect to a broken page would satisfy
    // the URL assertion and nothing a person cares about.
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();

    await context.close();
  });

  test('a stale cookie is treated as anonymous, not as a session', async ({ browser }) => {
    // The middleware only sees that a cookie is PRESENT — it has no database on
    // the Edge runtime, so a hand-written cookie sails past it. This is the
    // case the page's own `auth()` has to catch, and without that check a
    // forged cookie would be a login for the one route that edits identity.
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'titan.session',
        // Well-formed but naming no row: 32 bytes of hex, as real ones are.
        value: 'f'.repeat(64),
        domain: 'localhost',
        path: '/',
      },
    ]);
    const page = await context.newPage();

    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByTestId('profile-form')).toHaveCount(0);

    await context.close();
  });

  // -------------------------------------------------------------------------
  // Criterion: the avatar round trip
  // -------------------------------------------------------------------------

  test('uploading an avatar updates the row and shows on the profile after reload', async ({
    browser,
  }) => {
    const account = freshAccount('psav');
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, account);

    const before = await findUserByEmail(account.email);
    expect(before?.avatarPath, 'the fixture must start with no avatar').toBeNull();

    await gotoSettings(page);

    // Upload. The input is a real `<input type=file>`; the request it triggers
    // is a real multipart POST to /api/upload.
    await page.getByTestId('avatar-uploader-input').setInputFiles({
      name: 'portrait.jpg',
      mimeType: 'image/jpeg',
      buffer: await noiseJpeg(),
    });

    // The uploader has finished when it has a path to submit. Asserted on the
    // hidden input's value rather than on the preview, because the value is
    // what the form actually sends.
    await expect(page.getByTestId('avatar-uploader-value')).toHaveValue(
      /^\/uploads\/avatars\/[^/]+\/[a-z0-9]{24}\.webp$/,
    );
    const uploaded = await page.getByTestId('avatar-uploader-value').inputValue();

    // SPEC-006's layout, asserted rather than assumed: the directory segment is
    // the session user's own id. If the uploader ever wrote somewhere else,
    // `validateMediaPath` would reject the save and this test would fail on the
    // next line instead of here — but failing here says why.
    expect(uploaded).toContain(`/uploads/avatars/${before?.id}/`);

    await saveAndExpectLanded(page);

    // The row. This is the criterion's first half, and it is read from the
    // database rather than inferred from the page.
    const after = await findUserByEmail(account.email);
    expect(after?.avatarPath).toBe(uploaded);

    // The second half: visible on the public profile, after a reload, as a
    // real image the browser actually fetched.
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.request().resourceType() === 'image' && response.status() >= 400) {
        failures.push(`${response.status()}: ${response.url()}`);
      }
    });

    await page.goto(`/@${account.handle}`, { waitUntil: 'networkidle' });
    const avatar = page.getByTestId('profile-avatar').locator('img');
    await expect(avatar).toHaveAttribute('src', uploaded);
    // `naturalWidth > 0` is the difference between "an <img> is in the DOM"
    // and "the browser decoded pixels". A 404 leaves the element present and
    // the attribute correct, which is exactly what the weaker assertion checks.
    expect(await avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(failures, `failed image requests: ${failures.join(', ')}`).toEqual([]);

    await context.close();
  });

  // -------------------------------------------------------------------------
  // Validation, through the real form
  // -------------------------------------------------------------------------

  test('rejects a bad handle with a field-level error and no write', async ({ browser }) => {
    const account = freshAccount('pshdl');
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, account);

    await gotoSettings(page);
    await page.getByLabel('Handle').fill('Not A Handle');
    await saveAndExpectRejected(page);

    await expect(page.locator('[data-field-error="handle"]')).toBeVisible();
    // The row is untouched, and the form still holds what was typed — a
    // rejection that blanked the field would make a six-field form unusable.
    expect((await findUserByEmail(account.email))?.handle).toBe(account.handle);
    await expect(page.getByLabel('Handle')).toHaveValue('Not A Handle');

    await context.close();
  });

  test('rejects a 221-character bio with a field-level error and no write', async ({ browser }) => {
    const account = freshAccount('psbio');
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, account);

    await gotoSettings(page);
    await page.getByLabel('Bio').fill('a'.repeat(221));
    await saveAndExpectRejected(page);

    await expect(page.locator('[data-field-error="bio"]')).toBeVisible();
    // Not merely "not the 221-character bio": `updateUser` truncates at 220, so
    // a save that reached the repository would have stored a plausible-looking
    // 220-character value.
    expect((await findUserByEmail(account.email))?.bio).toBeNull();

    await context.close();
  });

  test('rejects a javascript: website with a field-level error and no write', async ({
    browser,
  }) => {
    const account = freshAccount('psweb');
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, account);

    await gotoSettings(page);
    await page.getByLabel('Website').fill('javascript:alert(1)');
    await saveAndExpectRejected(page);

    await expect(page.locator('[data-field-error="website"]')).toBeVisible();
    // The security half: the string never reaches the column, so it can never
    // become an `href` on a public page.
    expect((await findUserByEmail(account.email))?.socials).toEqual({});

    await context.close();
  });

  // -------------------------------------------------------------------------
  // The happy path, end to end
  // -------------------------------------------------------------------------

  test('saves name, bio and socials, and the profile shows them', async ({ browser }) => {
    const account = freshAccount('psok');
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, account);

    await gotoSettings(page);
    // Prefilled from the row, so the form is an editor rather than a blank
    // slate that silently clears whatever it does not show.
    await expect(page.getByLabel('Name')).toHaveValue(account.name);
    await expect(page.getByLabel('Handle')).toHaveValue(account.handle);

    await page.getByLabel('Name').fill('Ada B. Lovelace');
    await page.getByLabel('Bio').fill('Notes on engines.');
    // All three accepted spellings from SPEC-010's table, in one submission.
    await page.getByLabel('X profile').fill('@ada_dev');
    await page.getByLabel('GitHub profile').fill('https://github.com/ada-dev');
    await page.getByLabel('Website').fill('https://ada.example/');

    await saveAndExpectLanded(page);

    const saved = await findUserByEmail(account.email);
    expect(saved?.name).toBe('Ada B. Lovelace');
    expect(saved?.bio).toBe('Notes on engines.');
    // Normalized on the way in: two of the three inputs were not bare handles.
    expect(saved?.socials).toEqual({
      twitter: 'ada_dev',
      github: 'ada-dev',
      website: 'https://ada.example/',
    });

    await page.goto(`/@${account.handle}`);
    await expect(page.getByTestId('profile-name')).toHaveText('Ada B. Lovelace');
    await expect(page.getByTestId('profile-bio')).toHaveText('Notes on engines.');
    await expect(page.locator('[data-social="twitter"]')).toHaveAttribute(
      'href',
      'https://x.com/ada_dev',
    );

    await context.close();
  });

  test('changing the handle moves the profile URL and leaves no redirect', async ({ browser }) => {
    // SPEC-010: "changing it changes the profile URL and does not leave a
    // redirect (documented, single-user app)". The second clause is the one
    // worth asserting — it is a deliberate product decision that looks like an
    // omission, so a test is what stops someone "fixing" it later.
    const account = freshAccount('pshm');
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, account);

    const moved = `${account.handle.slice(0, 20)}_new`;
    await gotoSettings(page);
    await page.getByLabel('Handle').fill(moved);
    await saveAndExpectLanded(page);

    const response = await page.goto(`/@${moved}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('profile-handle')).toHaveText(`@${moved}`);

    // The old URL does not redirect; it simply stops being a profile.
    await page.goto(`/@${account.handle}`);
    expect(page.url()).toContain(`/@${account.handle}`);
    await expect(page.getByTestId('profile-page')).toHaveCount(0);

    await context.close();
  });
});
