import { expect, test } from '@playwright/test';

import { DARK_CLASS, THEME_STORAGE_KEY } from '../../lib/theme';

/**
 * SPEC-003's theme contract, observed in a real browser.
 *
 * "Theme switches via `class="dark"` on `<html>`, persisted in `localStorage`
 * under `titan.theme`, defaulting to `prefers-color-scheme`. No flash of wrong
 * theme: an inline blocking script sets the class before first paint."
 *
 * Three of those four are properties of the document itself and are asserted
 * directly below against the real app. The fourth — clicking the control — is
 * asserted where the control actually appears: SPEC-011 mounts `ThemeToggle`
 * in the top navigation, and this slice does not build the app shell, so no
 * page renders one yet. That suite is written out in full at the end of this
 * file and arms itself the moment a toggle is mounted. The toggle's own logic
 * (flip the class, persist the choice, read the document rather than local
 * state) is covered exhaustively in tests/unit/components.test.tsx, so the
 * behaviour is not unverified — only its wiring to a live click is.
 */

const LIGHT_BG = 'rgb(255, 255, 255)';
const DARK_BG = 'rgb(15, 15, 15)';

/** Seed localStorage before any page script runs — as if the visitor returned. */
async function withStoredTheme(
  page: import('@playwright/test').Page,
  theme: string | null,
): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    },
    { key: THEME_STORAGE_KEY, value: theme },
  );
}

/**
 * Sample the root background from first paint to 500ms.
 *
 * Installed as an init script so it is running before the document's own
 * scripts. Sampling starts on the first `requestAnimationFrame` callback —
 * which the browser runs immediately before the first paint — so the first
 * sample is the first colour the reader could possibly have seen. A flash is
 * then simply "more than one distinct value in the list".
 */
async function recordBackgroundDuringPaint(
  page: import('@playwright/test').Page,
  durationMs = 500,
): Promise<void> {
  await page.addInitScript((duration) => {
    const samples: string[] = [];
    (window as unknown as { __bgSamples: string[] }).__bgSamples = samples;
    const started = performance.now();
    const tick = () => {
      const root = document.documentElement;
      if (root) samples.push(getComputedStyle(root).backgroundColor);
      if (performance.now() - started < duration) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, durationMs);
}

test.describe('default theme follows prefers-color-scheme (SPEC-003)', () => {
  test('a dark-preferring visitor gets the dark palette on first visit', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto('/');

    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);
    await context.close();
  });

  test('a light-preferring visitor gets the light palette on first visit', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto('/');

    await expect(page.locator('html')).not.toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_BG);
    await context.close();
  });

  test('color-scheme is set too, so UA surfaces match from the first frame', async ({ browser }) => {
    // Without this the scrollbar and form controls stay light on a dark page,
    // and the canvas flashes white between navigations.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    await context.close();
  });
});

test.describe('a stored choice outranks the system preference (SPEC-003)', () => {
  test('stored dark wins over a light system preference', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    await withStoredTheme(page, 'dark');
    await page.goto('/');

    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);
    await context.close();
  });

  test('stored light wins over a dark system preference', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await withStoredTheme(page, 'light');
    await page.goto('/');

    await expect(page.locator('html')).not.toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_BG);
    await context.close();
  });

  test('the key is exactly titan.theme', async ({ page }) => {
    // Named literally as well as via the constant: SPEC-003 fixes the string,
    // and a rename of the constant must not quietly redefine the contract.
    expect(THEME_STORAGE_KEY).toBe('titan.theme');
    await withStoredTheme(page, 'dark');
    await page.goto('/');
    expect(await page.evaluate((key) => window.localStorage.getItem(key), THEME_STORAGE_KEY)).toBe(
      'dark',
    );
  });

  test('a corrupt stored value falls back to the system preference rather than breaking', async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await withStoredTheme(page, 'chartreuse');
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await context.close();
  });
});

test.describe('no flash of the wrong theme (SPEC-003)', () => {
  test('a dark reload never shows a light frame', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await withStoredTheme(page, 'dark');
    await recordBackgroundDuringPaint(page);

    await page.goto('/');
    // Reload so the measurement covers a genuine navigation, which is what the
    // criterion says ("a reload shows zero light-frame flash").
    await page.reload();
    await page.waitForTimeout(600);

    const samples = await page.evaluate(
      () => (window as unknown as { __bgSamples: string[] }).__bgSamples,
    );

    expect(samples.length, 'no frames were sampled — the recorder did not run').toBeGreaterThan(3);
    expect(new Set(samples), `background changed during paint: ${[...new Set(samples)].join(' -> ')}`)
      .toEqual(new Set([DARK_BG]));
    await context.close();
  });

  test('a light reload is equally stable', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    await withStoredTheme(page, 'light');
    await recordBackgroundDuringPaint(page);

    await page.goto('/');
    await page.reload();
    await page.waitForTimeout(600);

    const samples = await page.evaluate(
      () => (window as unknown as { __bgSamples: string[] }).__bgSamples,
    );
    expect(samples.length).toBeGreaterThan(3);
    expect(new Set(samples)).toEqual(new Set([LIGHT_BG]));
    await context.close();
  });

  test('the recorder can actually detect a flash', async ({ browser }) => {
    // A no-flash assertion that cannot fail proves nothing. This injects a real
    // one-frame flash and confirms the sampler catches it.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await withStoredTheme(page, 'dark');
    await recordBackgroundDuringPaint(page);
    await page.addInitScript(() => {
      requestAnimationFrame(() => {
        document.documentElement.style.backgroundColor = 'rgb(255, 0, 0)';
        requestAnimationFrame(() => {
          document.documentElement.style.backgroundColor = '';
        });
      });
    });

    await page.goto('/');
    await page.reload();
    await page.waitForTimeout(600);

    const samples = await page.evaluate(
      () => (window as unknown as { __bgSamples: string[] }).__bgSamples,
    );
    expect(new Set(samples).size).toBeGreaterThan(1);
    await context.close();
  });

  test('the theme script runs before the stylesheet paints anything', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    await withStoredTheme(page, 'dark');

    // Captured at document-start, i.e. the earliest a script can observe the
    // document. The class is already there, which is what "before first paint"
    // means in practice.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __classAtDcl: string }).__classAtDcl =
          document.documentElement.className;
      });
    });

    await page.goto('/');
    const classAtDcl = await page.evaluate(
      () => (window as unknown as { __classAtDcl: string }).__classAtDcl,
    );
    expect(classAtDcl).toContain(DARK_CLASS);
    await context.close();
  });
});

test.describe('the mounted toggle switches the theme', () => {
  /**
   * Armed, not stubbed. Every assertion below is complete and final; the suite
   * runs itself the moment any page mounts a `ThemeToggle`, with no edit here.
   *
   * The guard is the rendered control rather than a file path, because what
   * this suite needs is a toggle a user can actually click — which is a
   * property of the page, not of a file existing somewhere.
   */
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const mounted = await page.locator('[data-testid="theme-toggle"]').count();
    test.skip(
      mounted === 0,
      'skipped: needs TASK-008 (App Shell) — SPEC-011 mounts ThemeToggle in the top nav; no page renders one yet',
    );
  });

  test('clicking flips the class, and clicking again flips it back', async ({ page }) => {
    const html = page.locator('html');
    const toggle = page.locator('[data-testid="theme-toggle"]').first();
    const startedDark = (await html.getAttribute('class'))?.includes(DARK_CLASS) ?? false;

    await toggle.click();
    if (startedDark) await expect(html).not.toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    else await expect(html).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));

    await toggle.click();
    if (startedDark) await expect(html).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    else await expect(html).not.toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
  });

  test('the choice persists to localStorage and survives a reload', async ({ page }) => {
    const toggle = page.locator('[data-testid="theme-toggle"]').first();
    await toggle.click();

    const chosen = await page.evaluate((key) => window.localStorage.getItem(key), THEME_STORAGE_KEY);
    expect(chosen === 'dark' || chosen === 'light').toBe(true);

    await page.reload();
    const isDark = (await page.locator('html').getAttribute('class'))?.includes(DARK_CLASS);
    expect(isDark).toBe(chosen === 'dark');
  });

  test('the control names the theme it will switch to', async ({ page }) => {
    const toggle = page.locator('[data-testid="theme-toggle"]').first();
    const label = await toggle.getAttribute('aria-label');
    expect(label).toMatch(/switch to (light|dark) theme/i);
  });
});
