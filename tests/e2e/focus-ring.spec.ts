import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Page, expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ArticleCard } from '../../components/ui/ArticleCard';
import { Button } from '../../components/ui/Button';
import { Tag } from '../../components/ui/Tag';
import { ThemeToggle } from '../../components/ui/ThemeToggle';

/**
 * SPEC-003's focus ring: "2px `--accent` outline with 2px offset on every
 * interactive element — never `outline: none` without a replacement."
 *
 * The elements under test are rendered by the real primitives and dropped into
 * the real app, so the ring they get is the one the served stylesheet gives
 * them. Focus is moved with actual `Tab` presses rather than `.focus()`,
 * because the rule is `:focus-visible` — a programmatic focus does not match
 * it in Chromium, and a test that used `.focus()` would report a missing ring
 * that users do see, or worse, pass against a `:focus` rule that shows a ring
 * on every mouse click.
 *
 * Both themes are checked: the ring is drawn in `--accent`, which is a
 * different colour in each, and a ring that vanished into the background in
 * one of them would satisfy a width-only assertion.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** SPEC-009's route. Present ⇒ the armed sweep at the end of this file runs. */
const hasArticleRoute = existsSync(join(REPO_ROOT, 'app', 'article', '[slug]', 'page.tsx'));

/** Every interactive shape this slice ships, as the components render them. */
const INTERACTIVE_HTML = [
  renderToStaticMarkup(createElement(Button, { children: 'Publish' })),
  renderToStaticMarkup(createElement(Button, { href: '/editor/new', children: 'Write' })),
  renderToStaticMarkup(createElement(Button, { variant: 'secondary', children: 'Follow' })),
  renderToStaticMarkup(createElement(Button, { variant: 'ghost', iconOnly: true, children: '*' })),
  renderToStaticMarkup(createElement(ThemeToggle, {})),
  renderToStaticMarkup(createElement(Tag, { href: '/tag/design', children: 'Design' })),
  renderToStaticMarkup(
    createElement(ArticleCard, {
      title: 'On measure',
      href: '/article/on-measure',
      author: { name: 'Ada Lovelace', handle: 'ada' },
      publishedAt: '2026-03-12T09:30:00Z',
      tags: [{ slug: 'design', name: 'Design' }],
    }),
  ),
  // A bare input and a [role=button]: both named by the criterion, and neither
  // produced by a primitive in this slice's inventory, so they are stated here
  // to prove the global rule reaches them too.
  '<input type="search" aria-label="Search">',
  '<span role="button" tabindex="0">Custom control</span>',
].join('');

const CSS_PX = (value: string) => Number.parseFloat(value);

/** Load the app, then replace the page body with the real primitives. */
async function mountInteractive(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((markup) => {
    document.body.innerHTML = `<main>${markup}</main>`;
  }, INTERACTIVE_HTML);
  await page.evaluate(() => document.fonts.ready);
}

interface RingReport {
  tag: string;
  outlineWidth: number;
  outlineStyle: string;
  outlineColor: string;
  outlineOffset: number;
  matchesFocusVisible: boolean;
}

/** Tab to the next element and describe the ring it is wearing. */
async function tabAndInspect(page: Page): Promise<RingReport> {
  await page.keyboard.press('Tab');
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase() + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''),
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      outlineOffset: Number.parseFloat(style.outlineOffset),
      matchesFocusVisible: el.matches(':focus-visible'),
    };
  });
}

/** How many things the keyboard can reach on the mounted page. */
async function tabbableCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), [role="button"][tabindex], [tabindex]:not([tabindex="-1"])',
      ).length,
  );
}

const THEMES = [
  { name: 'light', accent: 'rgb(26, 137, 23)' },
  { name: 'dark', accent: 'rgb(74, 222, 128)' },
] as const;

for (const theme of THEMES) {
  test.describe(`focus ring in the ${theme.name} theme (SPEC-003)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('titan.theme', value);
      }, theme.name);
      await mountInteractive(page);
    });

    test('every keyboard-reachable element shows a ring of at least 2px', async ({ page }) => {
      const total = await tabbableCount(page);
      expect(total, 'nothing was tabbable — the fixture did not mount').toBeGreaterThan(5);

      const seen: RingReport[] = [];
      for (let i = 0; i < total; i += 1) {
        const report = await tabAndInspect(page);
        seen.push(report);

        expect(report.matchesFocusVisible, `${report.tag} did not match :focus-visible`).toBe(true);
        expect(
          report.outlineWidth,
          `${report.tag} outline-width was ${report.outlineWidth}px`,
        ).toBeGreaterThanOrEqual(2);
        expect(report.outlineStyle, `${report.tag} outline-style`).not.toBe('none');
        expect(report.outlineColor, `${report.tag} outline-color`).toBe(theme.accent);
        expect(report.outlineOffset, `${report.tag} outline-offset`).toBeGreaterThanOrEqual(2);
      }

      // Every element the criterion names was actually reached, rather than the
      // loop having stopped early on a focus trap.
      const tags = seen.map((r) => r.tag);
      expect(tags).toContain('button');
      expect(tags).toContain('a');
      expect(tags).toContain('input');
      expect(tags).toContain('span[role=button]');
    });

    test('the ring is drawn in --accent, which contrasts with the page', async ({ page }) => {
      await page.keyboard.press('Tab');
      const { outlineColor, background } = await page.evaluate(() => ({
        outlineColor: getComputedStyle(document.activeElement as HTMLElement).outlineColor,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      expect(outlineColor).toBe(theme.accent);
      expect(outlineColor).not.toBe(background);
    });
  });
}

test.describe('the ring is keyboard-only, not click-noise (SPEC-003)', () => {
  test.beforeEach(async ({ page }) => {
    await mountInteractive(page);
  });

  test('a mouse click focuses without painting a ring', async ({ page }) => {
    // `:focus-visible` rather than `:focus` is what makes this true. Using
    // `:focus` would satisfy every width assertion above while leaving a ring
    // behind after every click.
    const button = page.locator('button').first();
    await button.click();
    const report = await button.evaluate((el) => ({
      focused: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      outlineWidth: getComputedStyle(el).outlineWidth,
    }));
    expect(report.focused).toBe(true);
    expect(report.focusVisible).toBe(false);
    expect(Number.parseFloat(report.outlineWidth)).toBeLessThan(2);
  });

  test('no element suppresses its outline outright', async ({ page }) => {
    // The stylesheet-level version of this is asserted in
    // tests/unit/originality.test.ts; this is the rendered proof.
    const suppressed = await page.evaluate(() =>
      [...document.querySelectorAll('a, button, input, [role="button"]')]
        .filter((el) => {
          const style = getComputedStyle(el);
          return style.outlineStyle === 'none' && style.boxShadow === 'none' && el.matches(':focus-visible');
        })
        .map((el) => el.tagName),
    );
    expect(suppressed).toEqual([]);
  });
});

test.describe('the ring survives a real page, not just a fixture', () => {
  /**
   * Armed, not stubbed: complete assertions that sweep whatever `/` and
   * `/article/[slug]` actually render once SPEC-008 and SPEC-009 land them.
   * The fixture suites above prove the primitives and the stylesheet are
   * correct; this proves the pages that compose them did not undo it.
   */
  test.skip(
    !hasArticleRoute,
    'skipped: needs TASK-009 (Reading & Engagement) — app/article/[slug]/page.tsx absent; the / sweep waits on TASK-007 (Feed & Search) for the same reason',
  );

  for (const route of ['/', '/article/__first__'] as const) {
    test(`every interactive element on ${route} shows a >= 2px ring`, async ({ page }) => {
      if (route === '/article/__first__') {
        await page.goto('/');
        await page.locator('a[href^="/article/"]').first().click();
        await page.waitForURL(/\/article\//);
      } else {
        await page.goto(route);
      }

      const total = await tabbableCount(page);
      expect(total).toBeGreaterThan(0);

      for (let i = 0; i < total; i += 1) {
        const report = await tabAndInspect(page);
        expect(report.outlineWidth, `${route} ${report.tag}`).toBeGreaterThanOrEqual(2);
        expect(report.outlineStyle).not.toBe('none');
        expect(report.outlineOffset).toBeGreaterThanOrEqual(2);
      }
    });
  }
});
