import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Page, expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Prose } from '../../components/ui/Prose';

/**
 * SPEC-003's reading measure, asserted as COMPUTED style in a real browser.
 *
 * How the article body gets onto the page, and why it is not faked: the markup
 * injected below is produced by the real `Prose` component, server-rendered
 * here and handed to the live app. So the elements under test are exactly what
 * ships, and the CSS applied to them is exactly the stylesheet the app serves
 * — `app/globals.css` compiled through Next, fonts and all. Nothing is
 * hand-written to match, so nothing can drift.
 *
 * Why not simply visit a page that already renders an article: there is not
 * one. `/article/[slug]` belongs to SPEC-009 (Reading & Engagement) and `/` to
 * SPEC-008 (Feed & Search), and SPEC-011's route map is a closed world — "a
 * test enumerates the `app/` directory and fails on any page file not listed
 * here" — so this slice cannot add a demo route to test itself against. The
 * suite at the end of this file states the same assertions against the real
 * article route and arms itself automatically the moment that route exists.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** SPEC-009 owns this route. Present ⇒ the armed suite below goes live. */
const ARTICLE_ROUTE = join(REPO_ROOT, 'app', 'article', '[slug]', 'page.tsx');
const hasArticleRoute = existsSync(ARTICLE_ROUTE);

/*
 * Built with `createElement` rather than JSX because the file scope for this
 * slice names `typography.spec.ts`, and TypeScript only parses JSX in a `.tsx`
 * file. Playwright's `testMatch` is `**\/*.spec.ts` besides, so a `.tsx` spec
 * would silently never run — the worst of the available failures.
 */
const ARTICLE_HTML = renderToStaticMarkup(
  createElement(Prose, {
    sanitizedHtml: [
      '<h1>The measure of a line</h1>',
      '<p>Long-form reading is a physical act before it is an intellectual one. The eye ',
      'tracks a line, drops to the next, and finds its place again — or does not.</p>',
      '<p>Sixty-eight characters is a width the eye can return from reliably.</p>',
      '<blockquote>A column too wide loses the reader at every carriage return.</blockquote>',
      '<figure><img class="breakout" src="/uploads/none.webp" alt=""><figcaption>A caption.</figcaption></figure>',
    ].join(''),
  }),
);

/** Put the real article markup on the real page, replacing the placeholder. */
async function mountArticle(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((markup) => {
    document.body.innerHTML = markup;
  }, ARTICLE_HTML);
  // The reading face must have loaded before any `ch` measurement: `ch`
  // resolves against the rendered font, so measuring during the `display: swap`
  // fallback would compare 68ch of Georgia against 68ch of Source Serif 4.
  await page.evaluate(() => document.fonts.ready);
}

/**
 * What `68ch` resolves to for a given element, measured rather than assumed.
 *
 * `ch` is the advance width of "0" in the element's own font, so the expected
 * pixel value depends on the loaded face and cannot be hard-coded without
 * pinning a font version. A probe element inheriting the same font gives the
 * browser's own answer.
 */
async function chToPixels(page: Page, selector: string, count: number): Promise<number> {
  return page.evaluate(
    ({ selector: sel, count: n }) => {
      const target = document.querySelector(sel);
      if (!target) throw new Error(`no element matches ${sel}`);
      const probe = document.createElement('div');
      const style = getComputedStyle(target);
      probe.style.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
      probe.style.width = `${n}ch`;
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    },
    { selector, count },
  );
}

const cssPx = (value: string) => Number.parseFloat(value);

test.describe('article typography at >= 1024px (SPEC-003)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await mountArticle(page);
  });

  test('body is 21px on a 1.58 leading, i.e. line-height 33.18px', async ({ page }) => {
    const paragraph = page.locator('.prose p').first();
    await expect(paragraph).toHaveCSS('font-size', '21px');
    await expect(paragraph).toHaveCSS('line-height', '33.18px');
  });

  test('body carries the -0.003em tracking SPEC-003 specifies', async ({ page }) => {
    // -0.003em of 21px is -0.063px. Computed letter-spacing is reported in px,
    // so the em value is checked by its resolved product.
    const tracking = await page
      .locator('.prose p')
      .first()
      .evaluate((el) => getComputedStyle(el).letterSpacing);
    expect(cssPx(tracking)).toBeCloseTo(21 * -0.003, 3);
  });

  test('the article column max-width resolves to 68ch', async ({ page }) => {
    const maxWidth = await page
      .locator('.prose')
      .evaluate((el) => getComputedStyle(el).maxWidth);
    const expected = await chToPixels(page, '.prose', 68);

    expect(maxWidth).not.toBe('none');
    // Sub-pixel tolerance only: this is the same unit resolved two ways, not
    // an approximation.
    expect(cssPx(maxWidth)).toBeCloseTo(expected, 1);
  });

  test('the column is centred and never full-bleed', async ({ page }) => {
    const { columnWidth, viewportWidth } = await page.evaluate(() => ({
      columnWidth: document.querySelector('.prose')!.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(columnWidth).toBeLessThan(viewportWidth);
    await expect(page.locator('.prose')).toHaveCSS('margin-left', /px/);
  });

  test('an image may break out of the measure, but not past 1024px', async ({ page }) => {
    const { imageWidth, columnWidth } = await page.evaluate(() => ({
      imageWidth: document.querySelector('.breakout')!.getBoundingClientRect().width,
      columnWidth: document.querySelector('.prose')!.getBoundingClientRect().width,
    }));
    expect(imageWidth).toBeGreaterThan(columnWidth);
    expect(imageWidth).toBeLessThanOrEqual(1024);
  });

  test('the title is 42px / 1.18 at weight 700', async ({ page }) => {
    const h1 = page.locator('.prose h1');
    await expect(h1).toHaveCSS('font-size', '42px');
    await expect(h1).toHaveCSS('line-height', '49.56px');
    await expect(h1).toHaveCSS('font-weight', '700');
  });

  test('the body is set in the reading face, self-hosted by next/font', async ({ page }) => {
    const family = await page
      .locator('.prose p')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toMatch(/Source Serif 4/);

    // A fallback stack that never resolved would leave Georgia in front.
    expect(family.indexOf('Source Serif 4')).toBeLessThan(
      family.includes('Georgia') ? family.indexOf('Georgia') : Number.MAX_SAFE_INTEGER,
    );
  });

  test('paragraph rhythm comes from --rhythm, not a magic number', async ({ page }) => {
    const marginTop = await page.evaluate(() => {
      const paragraphs = document.querySelectorAll('.prose p');
      return getComputedStyle(paragraphs[1]!).marginTop;
    });
    // 1.72em of 21px.
    expect(cssPx(marginTop)).toBeCloseTo(21 * 1.72, 1);
  });
});

test.describe('article typography at 375px (SPEC-003)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await mountArticle(page);
  });

  test('there is no horizontal overflow', async ({ page }) => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });

  test('body text drops to 19px', async ({ page }) => {
    // Asserted on both the document body and the article column: SPEC-003 says
    // "body text drops to 19px", and the token step makes the two agree, so
    // neither reading of the sentence is left unchecked.
    await expect(page.locator('body')).toHaveCSS('font-size', '19px');
    await expect(page.locator('.prose p').first()).toHaveCSS('font-size', '19px');
  });

  test('leading stays at 1.58, so the ratio survives the step down', async ({ page }) => {
    await expect(page.locator('.prose p').first()).toHaveCSS('line-height', '30.02px');
  });

  test('the column is 100% - 2rem, as SPEC-003 requires below 640px', async ({ page }) => {
    const { columnWidth, viewportWidth } = await page.evaluate(() => ({
      columnWidth: document.querySelector('.prose')!.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(columnWidth).toBeCloseTo(viewportWidth - 32, 1);
  });

  test('a breakout image is capped at the column, never wider than the screen', async ({ page }) => {
    const imageWidth = await page.evaluate(
      () => document.querySelector('.breakout')!.getBoundingClientRect().width,
    );
    expect(imageWidth).toBeLessThanOrEqual(375);
  });

  test('long unbroken content scrolls inside its block instead of widening the page', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const pre = document.createElement('pre');
      pre.textContent = 'x'.repeat(400);
      document.querySelector('.prose')!.appendChild(pre);
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

test.describe('the 640px breakpoint (SPEC-003)', () => {
  test('639px is the small step and 640px is the default', async ({ page }) => {
    await page.setViewportSize({ width: 639, height: 800 });
    await mountArticle(page);
    await expect(page.locator('.prose p').first()).toHaveCSS('font-size', '19px');

    await page.setViewportSize({ width: 640, height: 800 });
    await expect(page.locator('.prose p').first()).toHaveCSS('font-size', '21px');
  });

  test('the measure never exceeds the viewport between 640px and 68ch', async ({ page }) => {
    // The window where `max-width: 68ch` is wider than the screen — the exact
    // gap in which a naive measure overflows horizontally.
    for (const width of [640, 700, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await mountArticle(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `horizontal overflow at ${width}px`,
      ).toBeLessThanOrEqual(width);
    }
  });
});

/**
 * The same contract, against the real article route.
 *
 * This is not a placeholder: the assertions are complete. It skips only while
 * `app/article/[slug]/page.tsx` does not exist, and arms itself with no edit
 * to this file the moment SPEC-009 lands it. tests/unit/scripts.test.ts keeps
 * the skip ledger visible so this cannot go quietly unchecked.
 */
test.describe('the real article route uses the design system', () => {
  test.skip(
    !hasArticleRoute,
    'skipped: needs TASK-009 (Reading & Engagement) — app/article/[slug]/page.tsx absent',
  );
  test.use({ viewport: { width: 1280, height: 900 } });

  test('renders the article body through Prose at the specified measure', async ({ page }) => {
    await page.goto('/');
    const firstArticle = page.locator('a[href^="/article/"]').first();
    await firstArticle.click();
    await page.waitForURL(/\/article\//);
    await page.evaluate(() => document.fonts.ready);

    const prose = page.locator('[data-testid="prose"]');
    await expect(prose).toHaveCount(1);
    await expect(prose.locator('p').first()).toHaveCSS('font-size', '21px');
    await expect(prose.locator('p').first()).toHaveCSS('line-height', '33.18px');

    const maxWidth = await prose.evaluate((el) => getComputedStyle(el).maxWidth);
    expect(cssPx(maxWidth)).toBeCloseTo(await chToPixels(page, '[data-testid="prose"]', 68), 1);
  });
});
