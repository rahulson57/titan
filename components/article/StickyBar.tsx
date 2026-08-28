'use client';

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The sticky engagement bar (SPEC-009).
 *
 * > Sticky bar | On scroll past the header: compact title + clap + bookmark,
 * > height 56px
 *
 * ── Why an IntersectionObserver and not a scroll handler ─────────────────
 * The trigger is a CROSSING — "past the header" — which is exactly what an
 * observer reports, and it reports it off the main thread. `ProgressBar` needs
 * a continuous position and so must read `scrollY` each frame; this needs one
 * boolean and would be measuring the header's geometry sixty times a second to
 * learn it. Different question, different instrument.
 *
 * The observed element is the header itself, passed by id for the same reason
 * `ProgressBar` takes one: the header is rendered by a server component and
 * there is no ref to hand across that boundary.
 *
 * ── Why the bar is always mounted ────────────────────────────────────────
 * It is rendered from the first paint and hidden, not conditionally mounted.
 * Mounting it on the crossing would insert 56px of fixed chrome into the
 * layout mid-scroll — a layout shift the reader sees and Cumulative Layout
 * Shift measures, against a criterion that puts CLS on this page below 0.1.
 * `visibility: hidden` is what hides it, and it is load-bearing twice over: it
 * takes the duplicated clap and bookmark controls out of the tab order, which
 * `opacity: 0` alone would not — an invisible but tabbable button is a focus
 * trap sitting over the article.
 *
 * ── Why it SLIDES rather than FADES ──────────────────────────────────────
 * The first version animated `opacity`, and axe caught it: mid-fade, the
 * title's `--fg` on `--bg` blends to #787878 on #ffffff — a contrast ratio of
 * **4.41:1** against SPEC-002's 4.5:1 floor, reported as a *serious*
 * violation. A transitioning opacity does not merely look faint, it makes the
 * text genuinely unreadable for the duration, and the a11y budget is zero
 * serious violations.
 *
 * Animating `transform` instead keeps the text at full opacity for every frame
 * of the motion, so there is no blended colour to fail on. It is also the
 * better animation: a bar that slides down from the top edge reads as chrome
 * arriving, where a fade reads as something appearing out of the page.
 *
 * This was found by auditing the real article page directly. The standing a11y
 * gate could not have caught it: `tests/e2e/a11y.spec.ts` audits
 * `/article/hello-world`, a slug the seed corpus does not contain, so it
 * audits the 404 page — and it never scrolls, so the bar is never shown.
 * Flagged to the coordinator rather than quietly worked around.
 *
 * ── The controls are consumers, not new state ────────────────────────────
 * `ClapButton` and `BookmarkButton` here read the same providers as the ones
 * in the footer, so the two copies of each number cannot disagree. That is the
 * whole reason those modules export providers — see `ClapButton.tsx`.
 */

import { useEffect, useState } from 'react';

import { BookmarkButton } from './BookmarkButton';
import { ClapButton } from './ClapButton';

/** SPEC-009 fixes the height. */
export const STICKY_BAR_HEIGHT = 56;

export interface StickyBarProps {
  /** Shown compactly once the full title has scrolled away. */
  title: string;
  /** `id` of the header element whose exit arms the bar. */
  headerId: string;
}

export function StickyBar({ title, headerId }: StickyBarProps) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const header = document.getElementById(headerId);
    if (!header) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Visible only when the header has left AND it left upwards. Without
          // the second test the bar would also appear when the header is below
          // the viewport, which is what a reader deep-linked to a footnote and
          // scrolling UP would see.
          setShown(!entry.isIntersecting && entry.boundingClientRect.top < 0);
        }
      },
      { threshold: 0 },
    );

    observer.observe(header);
    return () => observer.disconnect();
  }, [headerId]);

  return (
    <div
      data-testid="sticky-bar"
      data-shown={shown}
      // `aria-hidden` tracks the visual state so the duplicated clap and
      // bookmark controls are announced once, not twice, while the bar is
      // down. `inert` would be the tidier answer but is not in this project's
      // React/TS type surface, so `visibility: hidden` does the focus half.
      aria-hidden={!shown}
      style={{
        position: 'fixed',
        insetBlockStart: 0,
        insetInline: 0,
        height: `${STICKY_BAR_HEIGHT}px`,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        padding: '0 var(--space-5)',
        background: 'var(--bg)',
        borderBlockEnd: '1px solid var(--border)',
        fontFamily: 'var(--font-ui)',
        // Never a fractional opacity: see the header. The bar is either fully
        // opaque or fully out of the way.
        visibility: shown ? 'visible' : 'hidden',
        transform: shown ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 140ms ease',
      }}
    >
      <span
        data-testid="sticky-title"
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          // One line, clipped. A wrapping title would change the bar's height
          // and break the 56px the spec fixes.
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'var(--text-ui-size)',
          fontWeight: 600,
          color: 'var(--fg)',
        }}
      >
        {title}
      </span>
      <span style={{ display: 'inline-flex', gap: 'var(--space-3)', flex: '0 0 auto' }}>
        <ClapButton compact />
        <BookmarkButton compact />
      </span>
    </div>
  );
}

export default StickyBar;
