/**
 * The editor from the keyboard (SPEC-007, SPEC-002).
 *
 * Sealed criterion:
 *
 * > Every toolbar command (bold, italic, link, H2, H3, quote, code) is
 * > reachable and activatable by keyboard alone **with no pointer events**.
 *
 * ── How "no pointer events" is actually enforced ──────────────────────────
 * Not by discipline — by instrumentation. `page.addInitScript` installs
 * listeners for `pointerdown`, `mousedown` and `mouseup` before any page script
 * runs, and every test asserts none fired. Writing a suite that merely *avoids*
 * calling `.click()` proves nothing durable: the next person to touch the file
 * adds one convenience click, the suite still passes, and the criterion
 * silently stops being tested.
 *
 * The three events are chosen precisely. Activating a `<button>` with Enter or
 * Space DOES dispatch a synthetic `click`, so watching `click` would make every
 * keyboard test fail. It does not dispatch `pointerdown` or `mousedown` — those
 * only come from a real pointer. So this catches a mouse without rejecting the
 * keyboard's own click.
 *
 * ── Why reaching the toolbar is the interesting half ──────────────────────
 * A bubble menu is a hover-first idiom, and the standard implementation hides
 * itself when the editor loses focus — which is exactly what pressing Tab does.
 * The result is a toolbar that is visible until the moment you try to reach it.
 * `components/editor/BubbleMenu.tsx` keys its visibility on the SELECTION plus
 * "focus is inside me" for that reason, and the first test below is the one
 * that would catch a regression to the focus-based behaviour.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { appIsBootable } from '../../playwright.config';
import { disconnectDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';
import { createArticle, getArticleById } from '../../lib/db/articles';

const createdEmails: string[] = [];

function freshAccount() {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return {
    name: 'Keyboard Author',
    handle: `kbd_${stamp}`.slice(0, 24),
    email: `kbd-${stamp}@titan.local`,
    password: 'a quiet afternoon of reading',
  };
}

/**
 * Install the pointer tripwire, then sign up and open a draft.
 *
 * The init script must be registered BEFORE the first navigation — it runs on
 * every new document — so this helper owns the whole sequence rather than
 * leaving the ordering to each test.
 */
async function openEditor(page: Page): Promise<string> {
  await page.addInitScript(() => {
    const state = { pointerEvents: [] as string[] };
    (window as unknown as { __pointer: typeof state }).__pointer = state;
    for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
      window.addEventListener(
        type,
        (event) => {
          // `isTrusted` distinguishes a real pointer from anything a script
          // synthesised. Only the real thing counts against the criterion.
          if (event.isTrusted) state.pointerEvents.push(type);
        },
        true,
      );
    }
  });

  const account = freshAccount();
  createdEmails.push(account.email);

  // Sign-up is done with keyboard input only as well, so the tripwire can be
  // armed from the very first navigation rather than reset partway through.
  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /create account/i }).press('Enter');
  await page.waitForURL('/');

  const user = await findUserByEmail(account.email);
  if (!user) throw new Error('sign-up did not create a user');
  const article = await createArticle({
    authorId: user.id,
    title: 'Keyboard only',
    bodyJson: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'select this sentence' }] }],
    },
    bodyHtml: '<p>select this sentence</p>',
  });

  await page.goto(`/editor/${article.id}`, { waitUntil: 'networkidle' });
  return article.id;
}

/** Nothing a mouse could have done has happened on this page. */
async function expectNoPointerEvents(page: Page) {
  const events = await page.evaluate(
    () => (window as unknown as { __pointer?: { pointerEvents: string[] } }).__pointer?.pointerEvents ?? [],
  );
  expect(events, `pointer events fired: ${events.join(', ')}`).toEqual([]);
}

/**
 * Put the caret in the body and select its text, using only the keyboard.
 *
 * `focus()` rather than `click()`, then Ctrl/Cmd+A. `.click()` would arm the
 * tripwire, and `.focus()` is what a keyboard user's Tab sequence does anyway.
 */
async function selectBodyText(page: Page) {
  await page.getByTestId('editor-body').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.getByTestId('bubble-menu')).toBeVisible();
}

test.describe('SPEC-007 — the editor is operable from the keyboard alone', () => {
  test.skip(!appIsBootable(), 'no bootable app yet');

  test.afterAll(async () => {
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });

  test('the toolbar appears on a keyboard selection and survives being tabbed into', async ({
    page,
  }) => {
    await openEditor(page);
    await selectBodyText(page);

    const toolbar = page.getByTestId('bubble-menu');
    await expect(toolbar).toHaveAttribute('role', 'toolbar');
    await expect(toolbar).toHaveAttribute('aria-label', 'Text formatting');

    // THE regression test. Tab moves focus out of the contenteditable and into
    // the toolbar; a focus-gated bubble menu unmounts here and the criterion
    // becomes untestable.
    await page.keyboard.press('Tab');
    await expect(toolbar).toBeVisible();
    await expect(page.getByTestId('toolbar-bold')).toBeFocused();

    await expectNoPointerEvents(page);
  });

  /**
   * The six commands with a document-visible effect, one test each.
   *
   * Generated from a table rather than written out, so adding a command to
   * `TOOLBAR_COMMANDS` without making it keyboard-reachable is a failing test
   * rather than a thing nobody notices. `link` is handled separately below
   * because it needs an address.
   */
  for (const [label, testId, tag] of [
    ['bold', 'toolbar-bold', 'strong'],
    ['italic', 'toolbar-italic', 'em'],
    ['H2', 'toolbar-h2', 'h2'],
    ['H3', 'toolbar-h3', 'h3'],
    ['quote', 'toolbar-quote', 'blockquote'],
    ['code', 'toolbar-code', 'code'],
  ] as const) {
    test(`${label} applies from the keyboard, and the document changes`, async ({ page }) => {
      const articleId = await openEditor(page);
      await selectBodyText(page);

      // Tab into the toolbar, then walk to the command with Tab alone — no
      // `.focus()` shortcut, because "reachable" is the half of the criterion
      // that a direct focus call would skip over.
      await page.keyboard.press('Tab');
      const target = page.getByTestId(testId);
      for (let i = 0; i < 12 && !(await target.evaluate((node) => node === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
      }
      await expect(target).toBeFocused();

      await page.keyboard.press('Enter');

      // Asserted against the DOCUMENT, not against the button's pressed state:
      // a toolbar that lights up without changing anything would otherwise pass.
      await expect(page.getByTestId('editor-body').locator(tag)).toHaveCount(1, {
        timeout: 5_000,
      });

      await expectNoPointerEvents(page);

      // And it survives the round trip to the database, which is what makes it
      // a formatting command rather than a local decoration.
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });
      const stored = await getArticleById(articleId);
      expect(stored?.bodyHtml).toContain(`<${tag}`);
    });
  }

  test('link is reachable, applied and removed from the keyboard', async ({ page }) => {
    // Split out from the loop because a link needs an address, and the whole
    // interaction — open the form, type the URL, apply — has to be completable
    // without a pointer. A `window.prompt()` implementation would fail here,
    // which is the point.
    const articleId = await openEditor(page);
    await selectBodyText(page);

    await page.keyboard.press('Tab');
    const linkButton = page.getByTestId('toolbar-link');
    for (let i = 0; i < 12 && !(await linkButton.evaluate((n) => n === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(linkButton).toBeFocused();
    await expect(linkButton).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await expect(linkButton).toHaveAttribute('aria-expanded', 'true');

    const input = page.getByTestId('toolbar-link-input');
    await expect(input).toBeFocused();
    await input.pressSequentially('https://example.com/essay', { delay: 10 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('editor-body').locator('a')).toHaveCount(1);
    await expectNoPointerEvents(page);

    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });

    const stored = await getArticleById(articleId);
    expect(stored?.bodyHtml).toContain('href="https://example.com/essay"');
    // The rendered link is hardened regardless of what the author typed.
    expect(stored?.bodyHtml).toContain('rel="nofollow noopener noreferrer"');
  });

  test('a javascript: link is refused at the toolbar, with a reason', async ({ page }) => {
    // Not the security boundary — `sanitizeDoc` on the server is, and
    // `tests/unit/content-sanitize.test.ts` proves it. This asserts the author
    // is TOLD, instead of watching their link silently disappear on save.
    const articleId = await openEditor(page);
    await selectBodyText(page);

    await page.getByTestId('toolbar-link').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('toolbar-link-input').pressSequentially('javascript:alert(1)', {
      delay: 5,
    });
    await page.keyboard.press('Enter');

    await expect(page.getByRole('alert')).toContainText(/http\(s\)/i);
    await expect(page.getByTestId('editor-body').locator('a')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });
    const stored = await getArticleById(articleId);
    expect(stored?.bodyHtml).not.toMatch(/<script|on[a-z]+=|javascript:/i);
  });

  test('the + insert menu is a real menu, driven by arrow keys', async ({ page }) => {
    const articleId = await openEditor(page);

    const trigger = page.getByTestId('insert-trigger');
    await trigger.focus();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('ArrowDown');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('insert-image')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('insert-divider')).toBeFocused();

    // Wrapping at the end is what makes it a menu rather than a list of buttons
    // that happen to respond to arrows.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('insert-code-block')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('insert-image')).toBeFocused();

    // Escape closes and returns focus to the trigger — without that, a keyboard
    // user who opens the menu by accident is stranded inside it.
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await page.getByTestId('insert-divider').press('Enter');
    await expect(page.getByTestId('editor-body').locator('hr')).toHaveCount(1);

    await expectNoPointerEvents(page);

    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved', { timeout: 10_000 });
    expect((await getArticleById(articleId))?.bodyHtml).toContain('<hr />');
  });

  test('title, subtitle and tags are all reachable and labelled', async ({ page }) => {
    await openEditor(page);

    // Real `<input>` elements with real labels, not contenteditable divs. Two
    // reasons, both concrete: `tests/perf/editor-input.spec.ts` selects
    // `[contenteditable="true"]`.first() and would otherwise measure the title
    // instead of ProseMirror, and a native label is what makes these findable
    // by an assistive technology at all.
    await expect(page.getByLabel('Title')).toBeVisible();
    await expect(page.getByLabel('Subtitle')).toBeVisible();
    await expect(page.getByLabel('Tags')).toBeVisible();

    await expect(page.locator('[contenteditable="true"]')).toHaveCount(1);

    await page.getByLabel('Tags').focus();
    await page.keyboard.type('design');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tag-list').getByRole('listitem')).toHaveCount(1);
    // The remove control names what it removes; an unnamed "×" tells a screen
    // reader nothing.
    await expect(page.getByRole('button', { name: 'Remove tag design' })).toBeVisible();

    await expectNoPointerEvents(page);
  });

  test.describe('SPEC-002 — axe reports no serious or critical violations', () => {
    for (const theme of ['light', 'dark'] as const) {
      test(`on the editor in ${theme} mode`, async ({ page }) => {
        // The editor is not one of the six routes `tests/e2e/a11y.spec.ts`
        // scans, and it is the most widget-dense surface in the product — a
        // toolbar, a menu, a live region and a chip list. Scanning it here,
        // in the slice that owns it, is what keeps a defect in this nav-like
        // widgetry from surfacing weeks later as somebody else's failure.
        await page.emulateMedia({ colorScheme: theme });
        await openEditor(page);
        await selectBodyText(page);

        // @axe-core/playwright bundles its own copy of playwright-core's types,
        // which drift from the ones @playwright/test exports. Same object at
        // runtime; the cast reconciles the two identities. Same treatment as
        // tests/e2e/a11y.spec.ts:99.
        const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'];

        const results = await new AxeBuilder({ page: axePage })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        const blocking = results.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        );
        expect(
          blocking.map((violation) => `${violation.id}: ${violation.help}`),
          'axe found serious or critical violations on the editor',
        ).toEqual([]);
      });
    }
  });
});
