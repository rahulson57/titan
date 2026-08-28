/**
 * The accessibility gate (SPEC-002).
 *
 * > Every page in the v1 surface list passes `@axe-core/playwright` with zero
 * > serious or critical violations […] in both light and dark themes.
 *
 * Both themes are checked because the two most common ways to fail this are
 * theme-specific: a contrast pair that only holds on one background, and a
 * focus ring that vanishes against the other. Auditing light alone would pass
 * a dark theme nobody can read.
 *
 * `serious` and `critical` are the failing tiers, per the criterion. `minor`
 * and `moderate` findings are reported to the console so they stay visible
 * without gating the build on them.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * Each route is owned by a later slice and is skipped, by name, until it
 * exists. The scan itself is complete: as each route lands it starts being
 * audited with no edit to this file.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable } from '../../playwright.config';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The v1 surface list. `source` is the App Router file that must exist for the
 * route to resolve; `owner` names the task that brings it, so a skipped audit
 * reads as a dependency rather than an omission.
 *
 * `expectTestId` is optional and asserts the audit actually landed on the
 * surface it claims to be auditing. See `auditedTheRightPage` below for why a
 * missing one is a real hazard rather than a nicety.
 */
const SURFACES = [
  { name: 'home feed', path: '/', source: 'app/page.tsx', owner: 'TASK-007 (Feed & Search)' },
  { name: 'article', path: '/article/hello-world', source: 'app/article/[slug]/page.tsx', owner: 'TASK-009 (Reading & Engagement)' },
  { name: 'editor', path: '/editor/new', source: 'app/editor/new/page.tsx', owner: 'TASK-006 (Editor & Content)' },
  // TASK-010 / DEC-049. Two corrections, and both were live defects:
  //
  //  - `source` was `app/@[handle]/page.tsx`, a path that can never exist:
  //    Next reads a leading `@` as a parallel-route slot, so that directory
  //    normalizes to `/`, collides with `app/page.tsx` and 500s every route in
  //    the app. The guard below is `existsSync(source)`, so this audit would
  //    have skipped FOREVER while sealed criterion 14 read green.
  //  - `path` was `/@ada`, and there is no `ada` in the seed corpus:
  //    `prisma/seed.ts:71` sets `DEMO_HANDLE = 'demo'` and every other user is
  //    `${first}_${index}`. So the audit would have run against the not-found
  //    page and reported 0 serious / 0 critical for a surface it never visited.
  //
  // `expectTestId` is what makes the second class impossible here rather than
  // merely fixed once.
  { name: 'profile', path: '/@demo', source: 'app/[handle]/page.tsx', owner: 'TASK-010 (Profiles)', expectTestId: 'profile-page' },
  { name: 'tag', path: '/tag/design', source: 'app/tag/[slug]/page.tsx', owner: 'TASK-007 (Feed & Search)' },
  { name: 'search', path: '/search?q=design', source: 'app/search/page.tsx', owner: 'TASK-007 (Feed & Search)' },
] as const;

const THEMES = ['light', 'dark'] as const;

/**
 * Is there a theme system to put the page into dark mode at all?
 *
 * `lib/theme.ts` and the pre-paint class script are SPEC-003's, owned by
 * TASK-002. Until they land, `class="dark"` is never applied, and a "dark
 * theme" audit would silently re-audit the light theme and report a pass for
 * coverage it never had. That is the one failure mode worth more than a
 * skip, so the dark half waits explicitly.
 */
const hasThemeSystem = () => existsSync(join(REPO_ROOT, 'lib', 'theme.ts'));

/**
 * Put the page in a known theme before auditing.
 *
 * SPEC-003 stores the choice in `localStorage` under `titan.theme` and applies
 * it via `class="dark"` on `<html>` before first paint. Seeding storage rather
 * than clicking a toggle means the audit does not depend on ThemeToggle
 * existing yet, and cannot race the transition.
 */
async function applyTheme(page: Page, theme: (typeof THEMES)[number], path: string) {
  await page.addInitScript((value) => {
    window.localStorage.setItem('titan.theme', value);
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path, { waitUntil: 'networkidle' });

  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  expect(isDark, `expected the ${theme} theme to be applied to <html>`).toBe(theme === 'dark');
}

/**
 * Refuse to audit a page that is not the surface under test.
 *
 * An axe run against the wrong page passes. That is the whole problem: a URL
 * that 404s, or that redirects to sign-in, still renders a small, clean,
 * accessible document — so the audit reports "0 serious, 0 critical" and the
 * sealed criterion reads green for a surface the browser never visited. It is
 * the most comfortable kind of false pass, because nothing about it looks
 * wrong in a report.
 *
 * This is not hypothetical here. The profile surface probed `/@ada` against a
 * corpus whose only fixed handle is `demo`, and would have audited the
 * not-found page; the article surface probes `/article/hello-world`, a slug
 * that cannot exist under SPEC-004's `kebab(title)-<6 chars>` scheme.
 *
 * `expectTestId` is opt-in per surface rather than required for all six,
 * because the other rows are owned by other slices and adding an assertion to
 * a passing audit that this task does not own would be a scope violation
 * dressed up as diligence. The two remaining gaps are raised with the
 * coordinator rather than patched here — see the note in this task's proposal.
 */
async function auditedTheRightPage(
  page: Page,
  surface: { name: string; path: string; expectTestId?: string },
): Promise<void> {
  if (!surface.expectTestId) return;
  await expect(
    page.getByTestId(surface.expectTestId),
    `the ${surface.name} audit landed on ${page.url()} rather than ${surface.path} — ` +
      'auditing the wrong page would report a clean pass for a surface never visited',
  ).toBeVisible();
}

test.describe('SPEC-002 — zero serious or critical axe violations', () => {
  test.skip(!appIsBootable(), 'waiting on TASK-002 / TASK-007: no bootable app to audit yet');

  for (const surface of SURFACES) {
    for (const theme of THEMES) {
      test(`${surface.name} (${surface.path}) in ${theme} theme`, async ({ page }) => {
        test.skip(
          !existsSync(join(REPO_ROOT, surface.source)),
          `waiting on ${surface.owner}: ${surface.source} does not exist yet`,
        );
        test.skip(
          theme === 'dark' && !hasThemeSystem(),
          'waiting on TASK-002 (Design System): lib/theme.ts does not exist yet, so ' +
            'the page cannot be put into dark mode — auditing it now would just re-audit light',
        );

        await applyTheme(page, theme, surface.path);
        await auditedTheRightPage(page, surface);

        // @axe-core/playwright bundles its own copy of playwright-core's types,
        // which drift from the ones @playwright/test exports. The object is the
        // same Page at runtime; the cast reconciles the two type identities.
        const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'];

        const results = await new AxeBuilder({ page: axePage })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        const blocking = results.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        );

        // Advisory findings stay visible without gating the build.
        const advisory = results.violations.filter(
          (v) => v.impact === 'minor' || v.impact === 'moderate',
        );
        if (advisory.length > 0) {
          console.warn(
            `[a11y advisory] ${surface.path} (${theme}): ` +
              advisory.map((v) => `${v.id} x${v.nodes.length}`).join(', '),
          );
        }

        expect(
          blocking,
          blocking
            .map((v) => {
              const where = v.nodes
                .slice(0, 3)
                .map((n) => n.target.join(' '))
                .join('\n      ');
              return `${v.impact?.toUpperCase()} ${v.id}: ${v.help}\n  ${v.helpUrl}\n      ${where}`;
            })
            .join('\n\n'),
        ).toEqual([]);
      });
    }
  }
});

test.describe('SPEC-002 — the a11y gate covers the whole v1 surface list', () => {
  test('audits every route the criterion names, in both themes', () => {
    // Guards the gate against quiet erosion: a route dropped from SURFACES
    // would otherwise just stop being audited, with nothing turning red.
    expect(SURFACES.map((s) => s.name)).toEqual([
      'home feed',
      'article',
      'editor',
      'profile',
      'tag',
      'search',
    ]);
    expect(THEMES).toEqual(['light', 'dark']);
    expect(SURFACES.length * THEMES.length).toBe(12);
  });
});
