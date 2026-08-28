/**
 * Editor input latency budget (SPEC-002).
 *
 * > Editor keystroke -> local state commit | p95 < 16 ms
 *
 * 16ms is one frame at 60Hz. The budget is about *typing feeling immediate*:
 * anything slower and characters visibly lag the keyboard. It deliberately
 * measures keystroke to **local state commit**, not to autosave — autosave is
 * network-and-disk work that must never be on the keystroke path. If this
 * budget fails, the usual cause is exactly that: a save, a re-serialisation
 * of the whole document, or a full re-render wired into the input handler.
 *
 * Measured in the browser rather than against a headless ProseMirror instance,
 * because the cost being budgeted is the real one: DOM update plus React
 * commit, not schema arithmetic.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * The Tiptap surface at `app/editor/new/page.tsx` and `components/editor/
 * Editor.tsx` are owned by SPEC-007 (TASK-006, Editor & Content).
 */

import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable } from '../../playwright.config';
import { disconnectDb } from '../../lib/db/client';
import { deleteUser, findUserByEmail } from '../../lib/db/users';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const KEYSTROKES = 200;
const BUDGET_MS = 16; // one frame at 60Hz
const EDITOR_ROUTE = 'app/editor/new/page.tsx';

/** Nearest-rank p95: the reported value is an observation that actually happened. */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? Number.POSITIVE_INFINITY;
}

/**
 * Sign up, then open a blank draft, and hand back the editor.
 *
 * The navigation cannot be a bare `page.goto('/editor/new')`. `/editor` is in
 * SPEC-005's `PROTECTED_PREFIXES` (`lib/auth/config.ts`), so middleware sends an
 * anonymous visitor to `/signin` — and the failure that produces is
 * "`[contenteditable]` not found", which reads like an editor defect rather
 * than a missing session.
 *
 * That was not visible until TASK-006 landed: both tests below skip themselves
 * until `app/editor/new/page.tsx` exists, so this file's fixture was written
 * against a route that could not yet be opened and never once ran.
 *
 * A fresh account per test rather than a shared one, for the same reason
 * `tests/e2e/editor-a11y.spec.ts` does it: the suite runs `workers: 1` but the
 * budget is measured on a fresh document, and a reused account accumulates
 * drafts that make "the first editor on the page" ambiguous.
 */
const createdEmails: string[] = [];

async function openBlankEditor(page: Page) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const account = {
    name: 'Perf Author',
    handle: `perf_${stamp}`.slice(0, 24),
    email: `perf-${stamp}@titan.local`,
    password: 'a quiet afternoon of reading',
  };
  createdEmails.push(account.email);

  await page.goto('/signup');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Handle').fill(account.handle);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /create account/i }).press('Enter');
  await page.waitForURL('/');

  await page.goto('/editor/new', { waitUntil: 'networkidle' });

  // `getByTestId` rather than `[contenteditable="true"]`.first(): the editor
  // page also renders the title and subtitle as contenteditable fields, and
  // `.first()` would silently measure a plain input instead of ProseMirror —
  // which would pass the budget while testing nothing.
  const editor = page.getByTestId('editor-body');
  await expect(editor).toBeVisible();
  return editor;
}

test.describe(`SPEC-002 — keystroke to local commit p95 < ${BUDGET_MS}ms`, () => {
  test.skip(!appIsBootable(), 'waiting on TASK-002 / TASK-007: no bootable app yet');
  test.skip(
    !existsSync(join(REPO_ROOT, EDITOR_ROUTE)),
    `waiting on TASK-006 (Editor & Content): ${EDITOR_ROUTE} does not exist yet`,
  );

  test(`stays within one frame across ${KEYSTROKES} synthetic keystrokes`, async ({ page }) => {
    const editor = await openBlankEditor(page);
    await editor.click();

    // Typed in-page rather than through page.keyboard: the CDP round-trip per
    // key is tens of milliseconds and would swamp a 16ms budget entirely.
    // Dispatching locally and timing the synchronous commit measures the
    // editor, not the test harness.
    //
    // ── Why the sample ends where it does (operator-authorised, MSG-2368) ────
    // This test skipped itself until TASK-006 created `app/editor/new/page.tsx`,
    // so its first ever execution was in that slice — and it failed at 16.8ms
    // against a 16ms budget. The cause was the measurement, not the editor.
    //
    // The span used to close AFTER `await requestAnimationFrame`, so every
    // sample carried the wait for the next vsync: uniform 0-16.7ms at 60Hz,
    // whose p95 alone is ~15.9ms before any work is measured at all. Run
    // against a bare `<div contenteditable>` with no Next, no React and no
    // Tiptap, the old span scored:
    //
    //     bare <div contenteditable>   rAF p95 16.8ms   sync p95 0.2ms
    //     the real editor              rAF p95 16.8ms   sync p95 0.3ms
    //
    // An empty div and the editor were indistinguishable, which is the proof
    // that the number was the frame clock. A test that reports the same value
    // for an empty div as for the product cannot fail for a real reason and
    // cannot pass at all.
    //
    // Closing the span at the synchronous commit measures the criterion's own
    // words and restores the gate's power to fail: a save, a re-serialisation
    // of the document, or a synchronous re-render wired into the input handler
    // all land inside this span and would show up immediately. Everything else
    // is unchanged — 200 keystrokes, in-page dispatch, nearest-rank p95, and
    // the 16ms budget.
    const samples = await page.evaluate(async (count) => {
      const target = document.activeElement as HTMLElement | null;
      if (!target) throw new Error('the editor did not take focus');

      const letters = 'the quick brown fox jumps over the lazy dog ';
      const out: number[] = [];

      for (let i = 0; i < count; i++) {
        const key = letters[i % letters.length]!;
        const started = performance.now();

        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        document.execCommand('insertText', false, key);
        target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

        // THE CLOCK STOPS HERE — before the frame wait, not after it.
        //
        // ProseMirror applies the transaction and writes the DOM inside this
        // same task, so this span is exactly what the criterion names:
        // "keystroke to local state commit". Everything after it is waiting
        // for a screen, not for the editor.
        out.push(performance.now() - started);

        // The frame wait survives as a PACER, outside the measurement: it
        // keeps successive keystrokes on separate frames so the loop models
        // typing rather than a synchronous burst. It is deliberately not part
        // of the sample.
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      return out;
    }, KEYSTROKES);

    expect(samples).toHaveLength(KEYSTROKES);

    const observed = p95(samples);
    expect(
      observed,
      `keystroke p95 was ${observed.toFixed(1)}ms against a ${BUDGET_MS}ms budget. ` +
        'Check that nothing on the input path serialises the whole document or ' +
        'triggers autosave — autosave belongs on a debounce, off the keystroke path.',
    ).toBeLessThan(BUDGET_MS);
  });

  test('the document survives the burst intact', async ({ page }) => {
    // A fast editor that drops characters is not a fast editor. Without this,
    // the budget above could be met by an input handler that throttles away
    // real keystrokes.
    const editor = await openBlankEditor(page);
    await editor.click();
    await editor.pressSequentially('hello world', { delay: 0 });
    await expect(editor).toContainText('hello world');
  });

  test.afterAll(async () => {
    // The accounts are torn down rather than left behind: this suite runs in
    // the same database as the seed corpus the perf budgets are measured
    // against, and a drifting user count is exactly the kind of slow
    // contamination that makes a budget fail for no reason months later.
    for (const email of createdEmails) {
      const user = await findUserByEmail(email);
      if (user) await deleteUser(user.id);
    }
    await disconnectDb();
  });
});
