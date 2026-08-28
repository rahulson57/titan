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
import { disconnectDb, getDb } from '../../lib/db/client';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The v1 surface list. `source` is the App Router file that must exist for the
 * route to resolve; `owner` names the task that brings it, so a skipped audit
 * reads as a dependency rather than an omission.
 */
const SURFACES = [
  { name: 'home feed', path: '/', source: 'app/page.tsx', owner: 'TASK-007 (Feed & Search)' },
  // `path` is a fallback; `resolve` is what actually runs. The literal it
  // replaced was `/article/hello-world`, and no such slug can exist: SPEC-004
  // mints slugs as `kebab(title)-<6 chars of the article id>`. So this surface
  // audited the 404 page, and the sealed criterion — "0 serious and 0 critical
  // on /article/[slug] in BOTH themes" — had never once been evaluated against
  // an article. It skipped while TASK-009 was unbuilt, which hid it.
  //
  // Same trap `nav.spec.ts` carried, fixed the same way (MSG-2430): resolve a
  // real row, so a 404 here means "the route is not built" and never "that row
  // does not exist".
  {
    name: 'article',
    path: '/article/hello-world',
    resolve: async () => {
      const article = await getDb().article.findFirst({
        where: { status: 'PUBLISHED' },
        select: { slug: true },
        // Ordered by id so every run audits the same article — SPEC-002's
        // determinism rule covers what a test selects, not only what the seed writes.
        orderBy: { id: 'asc' },
      });
      return article ? `/article/${article.slug}` : null;
    },
    source: 'app/article/[slug]/page.tsx',
    owner: 'TASK-009 (Reading & Engagement)',
  },
  { name: 'editor', path: '/editor/new', source: 'app/editor/new/page.tsx', owner: 'TASK-006 (Editor & Content)' },
  { name: 'profile', path: '/@ada', source: 'app/@[handle]/page.tsx', owner: 'TASK-010 (Profiles)' },
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

test.describe('SPEC-002 — zero serious or critical axe violations', () => {
  test.skip(!appIsBootable(), 'waiting on TASK-002 / TASK-007: no bootable app to audit yet');

  // Resolving a real slug means this suite now opens the app's Prisma
  // connection in the RUNNER process, so it has to close it — the same
  // `afterAll` every other database-touching spec here carries. Without it the
  // connection is held for the whole run, and with `workers: 1` that is a
  // second writer against one SQLite file for every suite that follows. It
  // surfaces far away from here, as an unrelated later suite failing to write.
  test.afterAll(async () => {
    await disconnectDb();
  });

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

        const path = 'resolve' in surface ? await surface.resolve() : surface.path;
        test.skip(
          path === null,
          `the seed corpus holds no row to build ${surface.name} from`,
        );

        await applyTheme(page, theme, path as string);

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
