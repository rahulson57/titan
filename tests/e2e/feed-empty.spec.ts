/**
 * The three documented empty states, in a real browser (SPEC-008).
 *
 * > Each of `/`, `/tag/[slug]`, `/search?q=` renders its documented empty
 * > state when no rows match.
 *
 * | Surface        | Empty state                                    |
 * |----------------|------------------------------------------------|
 * | `/`            | "Nothing here yet" + link to `/editor/new`     |
 * | `/tag/[slug]`  | "No articles tagged X yet"                     |
 * | `/search?q=`   | "No results for X" + 5 popular tags            |
 *
 * ── How you get an empty `/` on a seeded database ─────────────────────────
 * This suite runs against the development server, and `npm run setup` has
 * already put SPEC-002's 500-article corpus behind it. The For-you tab is
 * therefore never empty, and making it empty would mean deleting the corpus
 * out from under every other suite in the run.
 *
 * `/?tab=following` viewed anonymously IS empty, by a rule SPEC-008 states in
 * its own words — "the Following tab [...] is empty for an anonymous viewer" —
 * and it renders `/`'s empty state, because the spec gives `/` one empty state
 * rather than one per tab. So the criterion is satisfied on the real route,
 * with real data, without staging a fake corpus. That the emptiness comes from
 * the viewer rather than from the database is the honest reading: the
 * criterion is about what the page renders when no rows match, not about why
 * there are no rows.
 *
 * ── Why the queries are gibberish rather than plausible ───────────────────
 * `zqxjvwk` and `no-such-topic-here` are chosen to be absent from a corpus
 * this suite does not control and cannot inspect first. A plausible-looking
 * miss like "kubernetes" would be one seed-corpus edit away from silently
 * becoming a hit, and the test would then assert the empty state against a
 * page showing results — reported as a failure of the page rather than of the
 * fixture.
 */

import { expect, test } from '@playwright/test';

import { appIsBootable } from '../../playwright.config';

/** Matches nothing, and cannot become a real word by accident. */
const NO_MATCH_QUERY = 'zqxjvwk';
/** A syntactically valid tag slug that nothing is tagged with. */
const NO_MATCH_TAG = 'no-such-topic-here';

test.describe('SPEC-008 — documented empty states', () => {
  test.skip(!appIsBootable(), 'no bootable app to render empty states in');

  test('/ renders "Nothing here yet" with a link to the editor', async ({ page }) => {
    await page.goto('/?tab=following');

    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();

    // SPEC-008 names the destination, so the link is asserted by href rather
    // than by its wording.
    const action = page.getByTestId('feed-empty-write');
    await expect(action).toHaveAttribute('href', '/editor/new');

    // The empty state replaces the list; it does not sit above one.
    await expect(page.getByTestId('feed-list')).toHaveCount(0);

    // And the tabs are still there, so the reader can get back to For you.
    await expect(page.getByTestId('feed-tab-for-you')).toBeVisible();
  });

  test('/ For you is NOT empty, so the assertion above is about emptiness', async ({ page }) => {
    // Guards the test above against passing for the wrong reason. If the feed
    // were broken and returned nothing at all, every empty-state assertion in
    // this file would still pass while the product showed a blank home page.
    await page.goto('/');
    await expect(page.getByTestId('feed-list')).toBeVisible();
    await expect(page.getByTestId('empty-state')).toHaveCount(0);
  });

  test('/tag/[slug] renders "No articles tagged X yet"', async ({ page }) => {
    await page.goto(`/tag/${NO_MATCH_TAG}`);

    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(
      empty.getByRole('heading', { name: `No articles tagged ${NO_MATCH_TAG} yet` }),
    ).toBeVisible();
    await expect(page.getByTestId('tag-feed')).toHaveCount(0);
  });

  test('/search?q= renders "No results for X" and five popular tags', async ({ page }) => {
    await page.goto(`/search?q=${NO_MATCH_QUERY}`);

    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(
      empty.getByRole('heading', { name: `No results for ${NO_MATCH_QUERY}` }),
    ).toBeVisible();

    // "+ 5 popular tags", from the spec's own empty-state column.
    const tags = page.getByTestId('popular-tags').getByRole('link');
    await expect(tags).toHaveCount(5);

    // The query is echoed back into the field, so a correction is one edit
    // rather than a retype.
    await expect(page.getByTestId('search-input')).toHaveValue(NO_MATCH_QUERY);
  });

  test('/search with no query invites a search instead of reporting no results', async ({
    page,
  }) => {
    await page.goto('/search');

    // Reporting "No results for " on a search nobody ran would be a small
    // lie, and an ugly one — the heading would end mid-sentence.
    await expect(page.getByRole('heading', { name: 'Search stories' })).toBeVisible();
    await expect(page.getByTestId('popular-tags')).toBeVisible();
  });

  test('an FTS5 operator typed into the box does not error the page', async ({ page }) => {
    // The rendered half of tests/unit/search-escaping.test.ts: a lone `"` is
    // an `fts5: syntax error` if it reaches MATCH unquoted, which the reader
    // would meet as a 500 on a URL they can type.
    const response = await page.goto('/search?q=%22');
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('search-page')).toBeVisible();
  });

  test('a tag slug that cannot exist renders rather than erroring', async ({ page }) => {
    // `x` is too short to be a valid slug and `normalizeTagSlug` throws on it.
    // Uncaught, that is a 500 on a public URL a crawler will find.
    const response = await page.goto('/tag/x');
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });
});
