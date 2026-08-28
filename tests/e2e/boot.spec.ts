/**
 * The boot contract (SPEC-001).
 *
 * > fresh clone -> `npm install && npm run setup && npm run dev` -> working app
 * > at http://localhost:3000 with seeded data.
 *
 * This is the criterion the whole runtime slice exists to satisfy: HTTP 200 at
 * the root within 60 seconds of a clean boot, with an empty `./data/`.
 *
 * The suite is in two halves. The first asserts the *preconditions* of the
 * contract — that the scripts, the port and the setup steps are what the
 * contract says they are — and runs unconditionally, because those are
 * properties of this slice. The second asserts the contract's *outcome* over
 * HTTP, and needs an App Router entry point to exist: `app/layout.tsx` is
 * owned by TASK-002 and `app/page.tsx` by TASK-007. Until one lands, `next
 * dev` has nothing to serve and Playwright attaches no web server (see
 * playwright.config.ts). Nothing here needs editing when that changes.
 *
 * ── `npm run setup` is executed by globalSetup, not from in here ───────────
 * These tests used to shell out to `scripts/setup.mjs` themselves. That put a
 * `prisma migrate deploy` in the middle of a Playwright run, after other specs
 * had already driven the app — a race that fails outright once the app has
 * written anything: an open Prisma connection that has WRITTEN blocks the
 * migration engine from taking its write lock, and the schema engine does not
 * inherit the app's `busy_timeout`, so it fails instantly rather than waiting.
 *
 * `tests/e2e/global.setup.ts` therefore runs setup — twice, since idempotency
 * is only observable across two runs — before any TEST runs, and these tests
 * assert the OUTCOME. The criteria are unchanged; only who executes them moved.
 * Note the invariant precisely (DEC-023): `globalSetup` runs AFTER `webServer`
 * boots, not before it. What makes the move safe is that no test has written
 * yet at that point — "setup before the app's first WRITE", not "setup before
 * the server starts". The reasoning, and what would break it, is in
 * `tests/e2e/global.setup.ts`.
 *
 * Authorised by the operator in MSG-2261 as part of TASK-004, which is where
 * the latent defect surfaced: SPEC-005's sign-up was the first e2e write in
 * the project, and SPEC-006/007/009/010 would each have hit it in turn.
 */

import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable, BASE_URL } from '../../playwright.config';
import { BOOT_SETUP } from './global.setup';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

test.describe('SPEC-001 — boot contract preconditions', () => {
  test('the documented boot sequence exists as runnable scripts', () => {
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs');
    expect(pkg.scripts.dev).toBe('next dev -p 3000');
    expect(existsSync(join(REPO_ROOT, 'scripts', 'setup.mjs'))).toBe(true);
  });

  test('`npm run setup` succeeds on a tree with no ./data/ and no .env.local', () => {
    // Executed for real by globalSetup, before any test had run. Running it
    // for real is still the point: it is the only way to know setup does not
    // depend on state a previous run left behind.
    //
    // The failure output is included in the message deliberately. The previous
    // version asserted an exit code with stderr discarded, so a broken gate
    // reported only "Command failed: npx prisma migrate deploy" — the actual
    // SQLite error had to be recovered by instrumenting the harness by hand.
    expect(
      process.env[BOOT_SETUP.ok],
      `npm run setup failed in globalSetup:\n${process.env[BOOT_SETUP.error] ?? '(no output captured)'}`,
    ).toBe('1');

    expect(existsSync(join(REPO_ROOT, 'data')), 'setup must create ./data/').toBe(true);
    expect(existsSync(join(REPO_ROOT, '.env.local')), 'setup must generate .env.local').toBe(true);
  });

  test('the generated AUTH_SECRET is real, not the committed placeholder', () => {
    const local = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
    const secret = /^AUTH_SECRET="(.+)"$/m.exec(local)?.[1] ?? '';

    expect(secret).not.toContain('replace-me');
    // 32 bytes of base64url. Short enough to notice if it ever became a
    // hard-coded constant.
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  test('setup is idempotent — a second run does not rotate the secret', () => {
    // Rotating AUTH_SECRET on every setup would sign every existing session
    // out, which turns a routine `npm run setup` into a surprise logout.
    //
    // Only observable across two runs, so globalSetup performs both and
    // compares `.env.local` byte for byte — any rewrite between identical runs
    // is a non-idempotency worth failing on, not just a rotated secret.
    expect(
      process.env[BOOT_SETUP.idempotent],
      'a second `npm run setup` rewrote .env.local — the AUTH_SECRET rotated, ' +
        'which signs out every existing session',
    ).toBe('1');
  });
});

test.describe('SPEC-001 — the app answers on port 3000', () => {
  test.skip(
    !appIsBootable(),
    'waiting on TASK-002 (app/layout.tsx) and TASK-007 (app/page.tsx): there is no App Router entry point to serve yet',
  );

  test('serves HTTP 200 at the root', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
  });

  test('binds localhost:3000 specifically, not an inherited port', async ({ page }) => {
    await page.goto('/');
    expect(page.url().startsWith(BASE_URL)).toBe(true);
  });

  test('renders a document rather than an error overlay', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('lang', /.+/);
    await expect(page.locator('body')).not.toContainText('Application error');
  });

  test('serves seeded content, not an empty shell', async ({ page }) => {
    // "with seeded data" is part of the contract — a 200 on an empty page
    // would satisfy the status code and miss the point.
    await page.goto('/', { waitUntil: 'networkidle' });
    const text = (await page.locator('body').innerText()).trim();
    expect(text.length, 'the root rendered no content; is the corpus seeded?').toBeGreaterThan(0);
  });
});
