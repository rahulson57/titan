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
 */

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable, BASE_URL } from '../../playwright.config';

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
    // The contract is specifically about a *clean clone*. Running setup for
    // real is the only way to know it does not depend on state a previous run
    // left behind. It is re-runnable by design, so this is safe here.
    execFileSync('node', ['scripts/setup.mjs', '--quiet', '--no-browsers'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: 120_000,
    });

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
    const before = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
    execFileSync('node', ['scripts/setup.mjs', '--quiet', '--no-browsers'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: 120_000,
    });
    expect(readFileSync(join(REPO_ROOT, '.env.local'), 'utf8')).toBe(before);
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
