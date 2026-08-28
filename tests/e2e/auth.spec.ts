/**
 * The credentials round trip, in a real browser (SPEC-005).
 *
 * Three sealed criteria land here, and every one of them is about a property
 * that only a browser can actually witness:
 *
 *   - "Signing up then signing in with correct credentials sets an httpOnly
 *      `titan.session` cookie with `SameSite=Lax` and creates exactly one
 *      Session row."
 *   - "`document.cookie` in the browser does NOT contain `titan.session`
 *      (httpOnly enforced)."
 *   - "Signing out deletes the Session row and a subsequent request with the
 *      stale cookie is treated as anonymous."
 *
 * A unit test can assert that `sessionCookieOptions()` says `httpOnly: true`.
 * Only a browser can assert that Chromium actually withheld the value from
 * `document.cookie` — which is the property, and the reason these are here.
 *
 * ── On reading the development database ───────────────────────────────────
 * SPEC-002's "never against `./data/titan.db`" rule governs the Vitest
 * integration suites, which get a throwaway file per suite. It cannot govern an
 * e2e run: the thing under test IS the dev server, and the dev server has
 * exactly one database.
 *
 * So this suite observes that database through `lib/db/` — `getDb()` from
 * `lib/db/client.ts`, the same accessor the app uses — rather than
 * constructing its own client. SPEC-004's boundary rule (no file outside
 * `lib/db/**` imports the Prisma client package) is not a style preference: a
 * client built anywhere else runs with `foreign_keys` OFF, and every cascade the
 * schema relies on silently stops happening. `tests/unit/db-boundary.test.ts`
 * enforces it, and it caught the first draft of this file.
 *
 * One honest note on the seam: `getDb().session.count(...)` reaches past the
 * typed repository functions, because `lib/db/users.ts` exposes no session
 * count. The cleaner shape would be a `countSessionsForUser` helper there —
 * but `lib/db/` belongs to TASK-003 (SPEC-004) and is outside this task's file
 * scope, so this uses the sanctioned accessor and flags the gap rather than
 * editing another slice's module.
 */

import { expect, test, type Page } from '@playwright/test';

import { disconnectDb, getDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

/** SPEC-005 fixes the cookie's name; the test must not invent its own. */
const SESSION_COOKIE = 'titan.session';

/**
 * How many live rows this user has in `Session`.
 *
 * No `DATABASE_URL` is set here on purpose: `lib/db/client.ts` falls back to
 * `DEFAULT_DATABASE_URL`, which is the same value the committed `.env` gives
 * the dev server. Parsing `.env` ourselves would be a second source of truth
 * for the one thing DEC-013 records as having gone wrong before — migrating
 * one database and serving another, with no error to say so.
 */
async function sessionCountFor(userId: string): Promise<number> {
  return getDb().session.count({ where: { userId } });
}

async function userIdFor(email: string): Promise<string | null> {
  return (await findUserByEmail(email))?.id ?? null;
}

/**
 * A fresh identity per test.
 *
 * A timestamp plus a counter guarantees no two accounts in a run — or across
 * two runs seconds apart — collide on the `User.email` unique index. A
 * collision would surface as a sign-up validation error and read as a product
 * bug rather than as test interference.
 */
let accountSeq = 0;
function freshAccount() {
  const stamp = `${Date.now().toString(36)}${accountSeq++}`;
  return {
    email: `e2e-${stamp}@titan.local`,
    // Long, unremarkable, and deliberately not on the 200-entry denylist.
    password: 'a quiet afternoon of reading',
    name: 'End To End',
    handle: `e2e_${stamp}`.slice(0, 24),
  };
}

async function signUp(page: Page, account: ReturnType<typeof freshAccount>) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /create account/i }).click();
  // SPEC-005: sign-up redirects to `/`.
  await page.waitForURL('/');
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

const createdEmails: string[] = [];

test.afterAll(async () => {
  // Delete only what this run created. Sessions go with the user by
  // `onDelete: Cascade` — a schema property SPEC-004 already proves — so this
  // is one call per account, not a cleanup loop that could be incomplete.
  for (const email of createdEmails) {
    const id = await userIdFor(email);
    if (id) await deleteUser(id);
  }
  await disconnectDb();
});

test.describe('SPEC-005 — sign up, sign in, sign out', () => {
  test('signing up sets an httpOnly SameSite=Lax titan.session cookie', async ({
    page,
    context,
  }) => {
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);

    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie, 'no titan.session cookie was set').toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
    // SPEC-005: `secure: false` on localhost http. A Secure cookie would never
    // be sent back over http and every request after sign-in would be anonymous.
    expect(cookie?.secure).toBe(false);
    // The opaque 32-byte id from `createSessionId`, hex-encoded.
    expect(cookie?.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test('signing in with correct credentials creates exactly one Session row', async ({
    page,
    context,
  }) => {
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);
    const userId = await userIdFor(account.email);
    expect(userId, 'sign-up did not create a User row').not.toBeNull();

    // Sign-up itself starts a session. Clearing the cookie leaves that row
    // behind, so the count is asserted as a DELTA — "exactly one Session row"
    // means one row per sign-in, which is the property that would break if
    // the action ever wrote a row per request.
    const afterSignUp = await sessionCountFor(userId as string);
    expect(afterSignUp).toBe(1);

    await context.clearCookies();
    await signIn(page, account.email, account.password);
    await page.waitForURL('/');

    expect(await sessionCountFor(userId as string)).toBe(afterSignUp + 1);

    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
  });

  test('document.cookie does not contain titan.session', async ({ page }) => {
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);

    // The httpOnly guarantee, witnessed from inside the page — this is what an
    // XSS payload would see, and it must not see the session.
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toContain(SESSION_COOKIE);
    expect(visible).not.toContain('titan.session');
  });

  test('a wrong password shows the single generic message', async ({ page, context }) => {
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);
    // Sign-up leaves a live session, and `/signin` answers a signed-in visitor
    // with the sign-out panel rather than a form. Drop the cookie first so this
    // test is exercising the anonymous sign-in path it is about.
    await context.clearCookies();

    await signIn(page, account.email, 'not the right password at all');

    const error = page.locator('[data-auth-error]');
    await expect(error).toBeVisible();
    // Same string as an unknown email — `auth-enumeration.test.ts` proves the
    // two are byte-identical; here we only prove the user is actually told.
    await expect(error).toHaveText('Email or password is incorrect.');
    await expect(page).toHaveURL(/\/signin/);
  });

  test('signing out deletes the Session row and the stale cookie is anonymous', async ({
    page,
    context,
  }) => {
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);
    const userId = (await userIdFor(account.email)) as string;
    expect(await sessionCountFor(userId)).toBe(1);

    // Capture the cookie BEFORE signing out, so it can be replayed afterwards.
    // Replaying it is the entire point: a JWT would still be accepted here and
    // "signed out" would be a client-side fiction. A deleted row cannot be.
    const staleCookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(staleCookie?.value).toMatch(/^[0-9a-f]{64}$/);

    // The real control, driven the way a user drives it. `/signin` renders the
    // sign-out form for an already-signed-in visitor (SPEC-011 will move it to
    // the user menu; the action it posts to does not change).
    await page.goto('/signin');
    await expect(page.locator('[data-session-handle]')).toHaveText(`@${account.handle}`);
    await page.getByRole('button', { name: /sign out/i }).click();
    await page.waitForURL('/');

    // Half one: the row is gone. This is what makes revocation real.
    expect(await sessionCountFor(userId)).toBe(0);

    // Half two: the browser is no longer carrying it either.
    expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value ?? '').toBe('');

    // Half three, the one a JWT would fail: put the old cookie back and prove
    // the server does not care. The value is still perfectly well-formed — it
    // simply names a row that no longer exists.
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: staleCookie?.value ?? '',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    // `/signin` asks `auth()`, which resolves the cookie against the database.
    // A stale id resolves to nothing, so the page renders the sign-in FORM
    // rather than the signed-in panel — that is "treated as anonymous",
    // observed rather than asserted about internals.
    await page.goto('/signin');
    await expect(page.locator('[data-session-handle]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
  });
});

test.describe('SPEC-005 — sign-up validation, in the browser', () => {
  test('rejects a reserved handle with a field-level error', async ({ page }) => {
    const account = freshAccount();

    await page.goto('/signup');
    await page.getByLabel('Name').fill(account.name);
    await page.getByLabel('Handle').fill('admin');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /create account/i }).click();

    // "Field-level" is the criterion's word: the error is attached to the
    // handle input, not dropped at the top of the form.
    const error = page.locator('[data-field-error="handle"]');
    await expect(error).toBeVisible();
    await expect(page.getByLabel('Handle')).toHaveAttribute('aria-invalid', 'true');
    // Nothing was created.
    expect(await userIdFor(account.email)).toBeNull();
  });

  test('rejects a denylisted password with a field-level error', async ({ page }) => {
    const account = freshAccount();

    await page.goto('/signup');
    await page.getByLabel('Name').fill(account.name);
    await page.getByLabel('Handle').fill(account.handle);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page.locator('[data-field-error="password"]')).toBeVisible();
    expect(await userIdFor(account.email)).toBeNull();
  });
});

test.describe('SPEC-005 — middleware routing', () => {
  test('an anonymous visitor to a protected route is sent to /signin with ?next', async ({
    page,
  }) => {
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/signin\?next=%2Fsettings%2Fprofile/);
  });

  test('signing in from a protected route returns to where the user was going', async ({
    page,
    context,
  }) => {
    // The `?next=` round trip end to end: middleware records the destination,
    // the form carries it through, and `safeNextPath` re-validates it on the
    // way back out so a crafted value cannot survive the trip.
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);
    await context.clearCookies();

    await page.goto('/bookmarks');
    await expect(page).toHaveURL(/\/signin\?next=%2Fbookmarks/);

    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await page.waitForURL(/\/bookmarks/);
  });

  test('an off-site ?next= is refused and falls back to /', async ({ page, context }) => {
    // Open-redirect guard, witnessed rather than unit-asserted: without
    // `safeNextPath` this form is a credible phishing hop — the user signs in
    // on the real site and is then handed to an attacker's replica.
    const account = freshAccount();
    createdEmails.push(account.email);

    await signUp(page, account);
    await context.clearCookies();

    await page.goto('/signin?next=https://example.com/phish');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // Landed on our own root, not on the attacker's host.
    await page.waitForURL('/');
    expect(new URL(page.url()).host).toBe('localhost:3000');
  });
});
