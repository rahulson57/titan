/**
 * Article page LCP budget (SPEC-002).
 *
 * > Article page LCP | < 1.5 s
 *
 * Measured against `next build && next start`, not `next dev`. SPEC-002 is
 * explicit about why: "dev-mode compilation dominates and is not a product
 * property." A dev-server measurement would mostly time webpack, fail loudly,
 * and tell you nothing about what a reader experiences.
 *
 * Run it with the production server attached:
 *
 *   npm run build && PW_WEBSERVER='npm run start' npx playwright test tests/perf/lcp.spec.ts
 *
 * Under a plain `npm test` the suite skips rather than reporting a dev-mode
 * number as if it were the budget — a wrong measurement is worse than none,
 * because it gets quoted later.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * `app/article/[slug]/page.tsx` is owned by SPEC-009 (TASK-009).
 */

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable } from '../../playwright.config';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BUDGET_MS = 1500;
const ARTICLE_ROUTE = 'app/article/[slug]/page.tsx';

/** True when the attached web server is the production build, not `next dev`. */
const isProductionServer = () => /npm run start/.test(process.env.PW_WEBSERVER ?? '');

test.describe(`SPEC-002 — article LCP < ${BUDGET_MS}ms`, () => {
  test.skip(!appIsBootable(), 'waiting on TASK-002 / TASK-007: no bootable app yet');
  test.skip(
    !existsSync(join(REPO_ROOT, ARTICLE_ROUTE)),
    `waiting on TASK-009 (Reading & Engagement): ${ARTICLE_ROUTE} does not exist yet`,
  );
  test.skip(
    !isProductionServer(),
    "budget is defined against `next build && next start`; re-run with PW_WEBSERVER='npm run start'",
  );

  test('largest contentful paint lands within budget on the seed corpus', async ({ page }) => {
    // Observe LCP from inside the page. `buffered: true` is essential — the
    // largest paint routinely happens before this script gets to subscribe,
    // and without it the observer would report nothing and the test would
    // pass vacuously.
    await page.addInitScript(() => {
      (window as unknown as { __lcp: number }).__lcp = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          (window as unknown as { __lcp: number }).__lcp = entry.startTime;
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });

    await page.goto('/article/hello-world', { waitUntil: 'load' });

    // LCP is only final once the page stops changing; nudge the browser to
    // settle and give any late hero image a chance to land.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    await page.waitForTimeout(500);

    const lcp = await page.evaluate(() => (window as unknown as { __lcp: number }).__lcp);

    expect(lcp, 'no LCP entry was recorded — the page may have rendered nothing').toBeGreaterThan(0);
    expect(
      lcp,
      `LCP was ${Math.round(lcp)}ms against a ${BUDGET_MS}ms budget. The usual causes are an ` +
        'un-dimensioned hero image, a blocking font fetch, or the article body arriving ' +
        'client-side instead of from the server component.',
    ).toBeLessThan(BUDGET_MS);
  });
});
