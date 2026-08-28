/** @jsxRuntime automatic */
/** @jsxImportSource react */
/* Pragmas: see components/ui/Button.tsx for why every file here carries them.
   They pin esbuild's JSX runtime for the Vitest transform and leave Next's
   own build untouched. */
import type { ReactNode } from 'react';

export interface ProseProps {
  children?: ReactNode;
  /**
   * Sanitised article HTML. Mutually exclusive with `children`.
   *
   * Prose does NOT sanitise. It is a typographic wrapper, and pretending
   * otherwise would put the security boundary in the wrong place — sanitising
   * belongs at the point the HTML is produced and stored (SPEC-007, Editor &
   * Content), where the allow-list can be applied once rather than at every
   * render. The prop name says out loud what the contract is.
   */
  sanitizedHtml?: string;
  /** Element to render. `article` on a reading page, `div` inside a card. */
  as?: 'article' | 'div' | 'section';
  className?: string;
}

/**
 * The article body renderer wrapper (SPEC-003) — the element that carries the
 * reading experience.
 *
 * It owns three things and nothing else: the reading face, the measure
 * (`--measure`, 68ch), and the vertical rhythm (`--rhythm`). Everything
 * inside is styled by the `.prose` descendant rules in globals.css, so the
 * article body needs no per-element classes and the editor's output renders
 * correctly without knowing anything about this design system.
 *
 * It already carries the measure, so it must NOT be nested inside
 * `.article-column` — the two would centre and pad twice.
 */
export function Prose({ children, sanitizedHtml, as = 'article', className }: ProseProps) {
  const Element = as;
  const classes = ['prose', className].filter(Boolean).join(' ');

  if (typeof sanitizedHtml === 'string') {
    return (
      <Element
        className={classes}
        data-testid="prose"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }

  return (
    <Element className={classes} data-testid="prose">
      {children}
    </Element>
  );
}

export default Prose;
