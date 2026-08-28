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

test.describe('a 404 thrown from inside a page keeps the theme (TASK-019, DEC-054)', () => {
  /**
   * The defect this pins was not a flash. It never settled.
   *
   * Next 15.5 serves two different 404s. For an unmatched path there is no
   * page to run, so it renders `not-found.tsx` into a normal document and
   * everything above already covers it. For a `notFound()` thrown from INSIDE
   * a page it abandons the shell and sends a stand-in document of its own —
   * `<html id="__next_error__">`, no stylesheet, no theme script — then
   * renders the real tree, root layout included, on the client from the flight
   * payload. React reproduces the layout's inline `<script>` into that head
   * but never executes it: a script element React creates and inserts does not
   * run its inline text. So `<html>` never got `dark`, `colorScheme` stayed
   * empty, and a dark-mode reader got a white 404 that stayed white.
   *
   * `/article/[slug]` is the cheapest route that throws it. The slug is a
   * literal that the seed corpus cannot produce — every seeded slug carries a
   * random suffix — and if one ever did, the status assertion below fails
   * loudly rather than quietly measuring a 200.
   *
   * `/editor/[id]` with an unknown id is the other half of the reported
   * defect and is deliberately not exercised here: it is the same throw
   * reaching the same stand-in document, but it is behind auth, so an
   * anonymous request redirects to `/signin` and never reaches the 404 at
   * all. Covering it would cost a signed-in session to prove nothing this
   * route does not. Named rather than dropped, so its absence reads as a
   * decision instead of an oversight.
   *
   * ── Two things deliberately NOT asserted here ─────────────────────────────
   *
   * 1. No-flash. `recordBackgroundDuringPaint` is not used on this route and
   *    must not be added to it. Next's stand-in document carries no stylesheet
   *    either, so its first paint is an unstyled frame roughly 200 ms wide in
   *    dev, and nothing in this repo runs before it. The fix takes the wrong
   *    theme from *permanent* to *that frame*; it does not close it, and
   *    closing it is not reachable from the root layout. Accepted as a known
   *    gap by the operator under DEC-054. An assertion here would be red on
   *    correct code.
   *
   * 2. Which mechanism applied the class. These tests state the property a
   *    reader can see, so they stay true however it gets fixed — including if
   *    a future Next stops taking the stand-in path at all. The one assertion
   *    that does name the mechanism is the last test in this block, and it is
   *    there for a specific reason it explains itself.
   */
  const IN_PAGE_404 = '/article/hello-world';

  test('a dark-preferring reader gets a dark in-page 404', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    const response = await page.goto(IN_PAGE_404);

    // The hard 404 is load-bearing (DEC-013): a soft 404 gets indexed and
    // cached, and this suite must never be the reason someone relaxes it.
    expect(response?.status(), `${IN_PAGE_404} must be a hard 404, not a soft one`).toBe(404);

    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);
    // `color-scheme` too, not just the class: without it the scrollbar and the
    // form controls in the 404's own search box stay light on a dark page.
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    await context.close();
  });

  test('a light-preferring reader gets a light one', async ({ browser }) => {
    // The mirror matters: a fix that unconditionally added `dark` would pass
    // the test above and be just as wrong.
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    const response = await page.goto(IN_PAGE_404);

    expect(response?.status()).toBe(404);
    await expect(page.locator('html')).not.toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_BG);
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light');
    await context.close();
  });

  test('a stored choice still outranks the system preference here', async ({ browser }) => {
    // This document reaches `localStorage` by a different route than every
    // other page — through the client-side copy of the script, not the
    // blocking one — so the precedence rule is worth restating on it rather
    // than assumed from the tests above.
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    await withStoredTheme(page, 'dark');
    const response = await page.goto(IN_PAGE_404);

    expect(response?.status()).toBe(404);
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${DARK_CLASS}\\b`));
    await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);
    await context.close();
  });

  test('the toggle in the nav mounts agreeing with the document, not behind it', async ({
    browser,
  }) => {
    // Ordering, not decoration. `ThemeToggle` reads the class off `<html>` in
    // an effect and names the theme it will switch TO. On this document the
    // class is applied by an effect as well, so if the toggle's effect ran
    // first the control would mount reading light on a dark page and offer to
    // switch the reader to the theme they are already looking at.
    //
    // What keeps that from happening is that the layout's client-side copy of
    // the script sits in `<head>`, whose effects run ahead of everything in
    // `<body>`. That is a real constraint on where the tag may live, so it is
    // asserted rather than left as a comment in the layout.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(IN_PAGE_404);

    const toggle = page.locator('[data-testid="theme-toggle"]').first();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-label', /switch to light theme/i);
    await context.close();
  });

  test(
    "the served in-page-404 document is still Next's client-only stand-in — " +
      'IF THIS FAILS THAT IS GOOD NEWS: Next now server-renders it, so confirm, ' +
      'then delete this test AND the second <Script> tag in app/layout.tsx',
    async ({ request }) => {
      /**
       * The only assertion in this block that names the mechanism, and it earns
       * its keep by preventing a silent disarm.
       *
       * Every test above states a property that would hold just as well if Next
       * started server-rendering this tree — which is the right way to write
       * them, but it means they would all keep passing while the thing they
       * exist to guard quietly stopped being exercised. Someone could then
       * delete the second `<script>` tag from the root layout and the suite
       * would say nothing.
       *
       * So this pins the assumption the fix rests on: the raw HTML for an
       * in-page 404 is Next's stand-in document, carrying neither our `<html>`
       * class nor a stylesheet. Note this is the response with NO JavaScript run
       * — `request.get`, not a page load — which is exactly why the client-side
       * copy of the script has to exist.
       *
       * IF THIS TEST FAILS AND THE OTHERS PASS, nothing is broken: Next changed
       * and now renders this tree on the server. That is good news. Confirm it,
       * then the second tag in `app/layout.tsx` is genuinely redundant and both
       * it and this test should go. Do not delete the tag while this still
       * passes.
       */
      const response = await request.get(IN_PAGE_404);
      expect(response.status()).toBe(404);

      const html = await response.text();
      const openingTag = html.match(/<html[^>]*>/)?.[0] ?? '';
      expect(
        openingTag,
        'Next no longer sends its stand-in document for an in-page 404 — read this test',
      ).toContain('__next_error__');
      expect(openingTag).not.toContain(DARK_CLASS);
    },
  );
});
