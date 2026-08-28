/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every component file carries
   them. They pin esbuild's JSX runtime for the Vitest transform and change
   not one byte of Next's build. */
import type { CSSProperties } from 'react';

import { HOME } from '../../lib/routes';

export interface WordmarkProps {
  /** Where the mark links. Defaults to `/`; `null` renders it as plain text. */
  href?: string | null;
  className?: string;
}

/**
 * The product wordmark (SPEC-011).
 *
 * > "The product wordmark is the text 'Titan' set in `--font-reading` — an
 * >  original mark. No third-party logo file exists in `public/`."
 *
 * It is text, not an image, and that is the whole design. SPEC-003's
 * originality rule is enforced by `tests/unit/originality.test.ts`, which
 * fails on any file under `public/` whose name matches `logo|wordmark|brand|
 * trademark` — so the cheapest way to satisfy the rule permanently is to have
 * nothing to satisfy it about. Text also scales, inherits the theme's `--fg`
 * in both palettes without a second asset, and is readable by a screen reader
 * as the product's name rather than as alt text somebody has to remember to
 * write.
 *
 * Rendered in `--font-reading` (Source Serif 4) rather than the UI face,
 * because the spec names that token. It is the one place in the chrome that
 * uses the reading face, which is what makes it read as a mark rather than as
 * another nav link.
 *
 * ── On the styles being inline ────────────────────────────────────────────
 * `app/globals.css` is SPEC-003's file (TASK-002) and is not in this task's
 * file scope, so no `.wordmark` rule can be added to it. Every value below
 * therefore reads a SPEC-003 design token instead of hard-coding a colour or a
 * step — the tokens are the contract, and honouring them from a `style` prop
 * honours it exactly as a stylesheet rule would. Same precedent, same reason,
 * as `app/(auth)/signin/page.tsx`.
 */
const markStyle: CSSProperties = {
  fontFamily: 'var(--font-reading)',
  fontSize: '26px',
  fontWeight: 700,
  // The mark is tight by design; the reading face is loose at display sizes.
  letterSpacing: '-0.02em',
  lineHeight: 1.1,
  color: 'var(--fg)',
  textDecoration: 'none',
  // A mark is one word. Wrapping it mid-name at 375px would be a defect.
  whiteSpace: 'nowrap',
};

export function Wordmark({ href = HOME, className }: WordmarkProps) {
  if (href === null) {
    return (
      <span className={className} style={markStyle} data-testid="wordmark">
        Titan
      </span>
    );
  }

  return (
    <a
      className={className}
      style={markStyle}
      href={href}
      // The mark is the home link, and "Titan" alone does not say so. The
      // accessible name says where it goes; the visible text stays the mark.
      aria-label="Titan — home"
      data-testid="wordmark"
    >
      Titan
    </a>
  );
}

export default Wordmark;
