'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The reading-progress bar (SPEC-009).
 *
 * > Reading-progress bar: 3px, `--accent`, width = scroll fraction of the body
 * > element.
 *
 * "of the BODY element" is the load-bearing half. The fraction is measured
 * against the article body, not the document: a page whose footer, author card
 * and sticky bar add several hundred pixels below the prose would otherwise
 * report 80% at the last line of the article, and the bar would never fill
 * while anything was left to read. So the geometry is taken from the element
 * the reader is actually reading.
 *
 * ── Why it takes an id rather than a ref ─────────────────────────────────
 * The body is rendered by a SERVER component (`<Prose>` inside `page.tsx`).
 * There is no ref to pass across that boundary, and hoisting the body into a
 * client component to obtain one would ship the whole article — the largest
 * thing on the page and the LCP element — to the client bundle for the sake of
 * a 3px rule. An id costs one `getElementById` on mount.
 *
 * ── Why `scrollY` and not IntersectionObserver ───────────────────────────
 * The value wanted is continuous ("width = scroll fraction"), and an observer
 * reports crossings, not positions. The handler is passive and does nothing
 * but read two numbers and set a CSS width, and it is throttled to one write
 * per animation frame so a fast scroll cannot queue up layout work.
 *
 * ── Accessibility ────────────────────────────────────────────────────────
 * It is a `progressbar` with a name and a value, so it is perceivable to a
 * screen reader rather than being a decorative stripe. `aria-hidden` would
 * have been the other defensible answer; announcing it is the better one
 * because reading position is genuinely useful information, and the value is
 * only updated in whole percent so it cannot chatter.
 */

import { useEffect, useState } from 'react';

export interface ProgressBarProps {
  /** `id` of the element whose scroll-through defines the fraction. */
  targetId: string;
  /** SPEC-009 fixes the height at 3px; exposed only so tests can be explicit. */
  height?: number;
}

/**
 * Fraction of `element` that has been scrolled past, in 0..1.
 *
 * Split out and exported because it is where every off-by-one in this
 * component would live, and because keeping it free of the DOM makes the
 * reasoning below reviewable on its own terms. Its behaviour is asserted
 * through the browser, in `tests/e2e/article-page.spec.ts` — this slice's file
 * scope contains no unit-test file for `components/**`, so the arithmetic is
 * documented here rather than pinned by a separate suite.
 *
 * The denominator is the element's height MINUS the viewport, because the last
 * viewport-worth of the body is on screen when the reader reaches the end —
 * dividing by the full height would top out at 1 only once the body had
 * scrolled entirely out of view, which never happens at the foot of a page.
 * A body shorter than the viewport has nothing to scroll and reads as
 * complete.
 */
export function scrollFraction(
  top: number,
  height: number,
  viewportHeight: number,
): number {
  const scrollable = height - viewportHeight;
  if (scrollable <= 0) return 1;
  // `-top` is how far the element's start has travelled above the viewport.
  const passed = -top;
  return Math.min(1, Math.max(0, passed / scrollable));
}

export function ProgressBar({ targetId, height = 3 }: ProgressBarProps) {
  const [fraction, setFraction] = useState(0);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;

    let frame = 0;

    const measure = () => {
      frame = 0;
      const box = target.getBoundingClientRect();
      setFraction(scrollFraction(box.top, box.height, window.innerHeight));
    };

    const schedule = () => {
      // One write per frame. Scroll fires far faster than the browser paints,
      // and an unthrottled setState here is the classic way to make a smooth
      // page feel heavy on a trackpad.
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [targetId]);

  const percent = Math.round(fraction * 100);

  return (
    <div
      role="progressbar"
      aria-label="Reading progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-testid="reading-progress"
      style={{
        position: 'fixed',
        insetBlockStart: 0,
        insetInline: 0,
        height: `${height}px`,
        // Above the sticky bar: the bar is chrome, the progress rule is the
        // page's own edge and should never be occluded by it.
        zIndex: 60,
        pointerEvents: 'none',
        // The track is transparent rather than a grey rail. SPEC-009 specifies
        // a bar of `--accent` and a width, not a two-tone meter, and a visible
        // rail across the top of every article is a heavier frame than the
        // reading experience wants.
        background: 'transparent',
      }}
    >
      <div
        data-testid="reading-progress-fill"
        style={{
          height: '100%',
          width: `${percent}%`,
          background: 'var(--accent)',
          // Transitioning the width smooths the per-frame steps without
          // lagging behind a deliberate jump (End key, anchor link).
          transition: 'width 90ms linear',
        }}
      />
    </div>
  );
}

export default ProgressBar;
