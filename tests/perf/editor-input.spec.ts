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

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appIsBootable } from '../../playwright.config';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const KEYSTROKES = 200;
const BUDGET_MS = 16; // one frame at 60Hz
const EDITOR_ROUTE = 'app/editor/new/page.tsx';

/** Nearest-rank p95: the reported value is an observation that actually happened. */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? Number.POSITIVE_INFINITY;
}

test.describe(`SPEC-002 — keystroke to local commit p95 < ${BUDGET_MS}ms`, () => {
  test.skip(!appIsBootable(), 'waiting on TASK-002 / TASK-007: no bootable app yet');
  test.skip(
    !existsSync(join(REPO_ROOT, EDITOR_ROUTE)),
    `waiting on TASK-006 (Editor & Content): ${EDITOR_ROUTE} does not exist yet`,
  );

  test(`stays within one frame across ${KEYSTROKES} synthetic keystrokes`, async ({ page }) => {
    await page.goto('/editor/new', { waitUntil: 'networkidle' });

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toBeVisible();
    await editor.click();

    // Typed in-page rather than through page.keyboard: the CDP round-trip per
    // key is tens of milliseconds and would swamp a 16ms budget entirely.
    // Dispatching locally and timing to the end of the same frame measures the
    // editor, not the test harness.
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

        // Resolve after the frame in which the commit was painted, so the
        // sample covers the React commit rather than stopping at dispatch.
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        out.push(performance.now() - started);
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
    await page.goto('/editor/new', { waitUntil: 'networkidle' });
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await editor.pressSequentially('hello world', { delay: 0 });
    await expect(editor).toContainText('hello world');
  });
});
